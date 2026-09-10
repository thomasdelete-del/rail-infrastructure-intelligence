import asyncio
import json
from typing import Any

import httpx
from sqlalchemy import text

from app.database import get_engine


OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
)
_OSM_PLATFORM_CACHE: dict[tuple[float, float], dict[str, Any]] = {}


def platform_query(latitude: float, longitude: float, radius: int = 900) -> str:
    return (
        f'[out:json][timeout:25];('
        f'nwr(around:{radius},{latitude},{longitude})[railway=platform];'
        f'nwr(around:{radius},{latitude},{longitude})[railway=platform_edge];'
        f'nwr(around:{radius},{latitude},{longitude})[public_transport=platform][train=yes];'
        f'nwr(around:{radius},{latitude},{longitude})[railway=subway_entrance];'
        f'nwr(around:{radius},{latitude},{longitude})[entrance][railway];'
        f'nwr(around:{radius},{latitude},{longitude})[highway=elevator];'
        ');out center tags geom;'
    )


def filter_rail_objects(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep rail infrastructure and reject unrelated nearby bus platforms."""
    result = []
    for element in elements:
        tags = element.get("tags") or {}
        if tags.get("railway") in {"platform", "platform_edge", "subway_entrance"} or (
            tags.get("public_transport") == "platform" and tags.get("train") == "yes"
        ) or (
            tags.get("entrance") and tags.get("railway")
        ) or tags.get("highway") == "elevator":
            result.append(element)
    return result


def _platform_elements(elements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        element for element in elements
        if (element.get("tags") or {}).get("railway") in {"platform", "platform_edge"}
        or (
            (element.get("tags") or {}).get("public_transport") == "platform"
            and (element.get("tags") or {}).get("train") == "yes"
        )
    ]


def _cached_platforms(rl100: str) -> list[dict[str, Any]]:
    try:
        with get_engine().connect() as connection:
            payload = connection.execute(
                text("SELECT elements FROM osm_bahnsteig_cache WHERE ds100_rl100=:rl100"),
                {"rl100": rl100},
            ).scalar()
    except RuntimeError:
        return []
    if isinstance(payload, str):
        return json.loads(payload)
    return payload or []


def _store_platforms(rl100: str, elements: list[dict[str, Any]]) -> None:
    platforms = _platform_elements(elements)
    if not platforms:
        return
    try:
        with get_engine().begin() as connection:
            connection.execute(text("""
                INSERT INTO osm_bahnsteig_cache (ds100_rl100, elements, updated_at)
                VALUES (:rl100, CAST(:elements AS JSONB), now())
                ON CONFLICT (ds100_rl100) DO UPDATE SET
                    elements=EXCLUDED.elements, updated_at=now()
            """), {"rl100": rl100, "elements": json.dumps(platforms)})
    except RuntimeError:
        pass


async def _refresh_osm_platforms(latitude: float, longitude: float, rl100: str | None) -> dict[str, Any]:
    errors: list[str] = []
    cache_key = (round(latitude, 3), round(longitude, 3))
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        async def fetch_endpoint(endpoint: str) -> tuple[str, list[dict[str, Any]], str | None]:
            try:
                response = await client.post(
                    endpoint,
                    data={"data": platform_query(latitude, longitude)},
                    headers={"User-Agent": "rail-infrastructure-intelligence/1.5"},
                )
                response.raise_for_status()
                elements = filter_rail_objects(response.json().get("elements", []))
                return endpoint, elements, None if elements else "empty"
            except (httpx.HTTPError, ValueError) as error:
                return endpoint, [], type(error).__name__

        tasks = [asyncio.create_task(fetch_endpoint(endpoint)) for endpoint in OVERPASS_ENDPOINTS]
        try:
            for completed in asyncio.as_completed(tasks):
                endpoint, elements, error = await completed
                if elements:
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    result = {"source": endpoint, "fallback_used": endpoint != OVERPASS_ENDPOINTS[0], "cache_used": False, "elements": elements}
                    _OSM_PLATFORM_CACHE[cache_key] = result
                    if rl100:
                        _store_platforms(rl100, elements)
                    return result
                errors.append(f"{endpoint}:{error}")
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    cached = _OSM_PLATFORM_CACHE.get(cache_key)
    if cached:
        return {**cached, "source": "last-successful-overpass-response", "fallback_used": True, "cache_used": True, "errors": errors}
    return {"source": None, "fallback_used": True, "cache_used": False, "elements": [], "errors": errors}


async def load_osm_platforms(latitude: float, longitude: float, rl100: str | None = None) -> dict[str, Any]:
    normalized_rl100 = rl100.strip().upper() if rl100 else None
    if normalized_rl100:
        cached = _cached_platforms(normalized_rl100)
        if cached:
            asyncio.create_task(_refresh_osm_platforms(latitude, longitude, normalized_rl100))
            return {
                "source": "railway-osm-platform-cache",
                "fallback_used": False,
                "cache_used": True,
                "refresh_running": True,
                "elements": cached,
            }
    return await _refresh_osm_platforms(latitude, longitude, normalized_rl100)
