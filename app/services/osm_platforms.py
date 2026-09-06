from typing import Any

import httpx


OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)


def platform_query(latitude: float, longitude: float, radius: int = 900) -> str:
    return (
        f'[out:json][timeout:25];('
        f'nwr(around:{radius},{latitude},{longitude})[railway=platform];'
        f'nwr(around:{radius},{latitude},{longitude})[railway=platform_edge];'
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
            tags.get("entrance") and tags.get("railway")
        ) or tags.get("highway") == "elevator":
            result.append(element)
    return result


async def load_osm_platforms(latitude: float, longitude: float) -> dict[str, Any]:
    errors: list[str] = []
    async with httpx.AsyncClient(timeout=35, follow_redirects=True) as client:
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                response = await client.post(
                    endpoint,
                    data={"data": platform_query(latitude, longitude)},
                    headers={"User-Agent": "rail-infrastructure-intelligence/1.4"},
                )
                response.raise_for_status()
                elements = filter_rail_objects(response.json().get("elements", []))
                if elements:
                    return {"source": endpoint, "fallback_used": endpoint != OVERPASS_ENDPOINTS[0], "elements": elements}
                errors.append(f"{endpoint}:empty")
            except (httpx.HTTPError, ValueError) as error:
                errors.append(f"{endpoint}:{type(error).__name__}")
    return {"source": None, "fallback_used": True, "elements": [], "errors": errors}
