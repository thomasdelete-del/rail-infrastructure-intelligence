from __future__ import annotations

from difflib import SequenceMatcher
from math import asin, cos, radians, sin, sqrt
from typing import Any

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def _coordinates(element: dict[str, Any]) -> tuple[float | None, float | None]:
    center = element.get("center") or {}
    return element.get("lat", center.get("lat")), element.get("lon", center.get("lon"))


def _distance_m(a_lat: float, a_lon: float, b_lat: float, b_lon: float) -> float:
    lat1, lon1, lat2, lon2 = map(radians, (a_lat, a_lon, b_lat, b_lon))
    value = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * asin(sqrt(value))


def _normalized_name(value: str) -> str:
    return " ".join(value.casefold().replace("bahnhof", " ").replace("hbf", " ").split())


def select_station_identity(elements: list[dict[str, Any]], name: str, latitude: float, longitude: float) -> dict[str, Any]:
    candidates = []
    for element in elements:
        tags = element.get("tags") or {}
        if tags.get("railway") not in {"station", "halt"}:
            continue
        lat, lon = _coordinates(element)
        if lat is None or lon is None:
            continue
        distance = _distance_m(latitude, longitude, float(lat), float(lon))
        similarity = SequenceMatcher(None, _normalized_name(name), _normalized_name(tags.get("name", ""))).ratio()
        score = distance - similarity * 350
        candidates.append((score, distance, similarity, element))
    candidates.sort(key=lambda item: item[0])
    if not candidates or candidates[0][1] > 1500:
        raise LookupError("No railway station found within 1.5 km")
    best = candidates[0]
    if len(candidates) > 1 and candidates[1][0] - best[0] < 35 and best[2] < 0.75:
        raise ValueError("Station identity is ambiguous")
    element, tags = best[3], best[3].get("tags") or {}
    return {
        "matched_name": tags.get("name"), "distance_m": round(best[1], 1),
        "name_similarity": round(best[2], 3), "osm_type": element.get("type"), "osm_id": element.get("id"),
        "eva": tags.get("ref:ibnr") or tags.get("ref:IBNR") or tags.get("uic_ref"),
        "ril": tags.get("railway:ref"), "station_number": tags.get("ref:station"),
        "identity_status": "identified" if any((tags.get("ref:ibnr"), tags.get("ref:IBNR"), tags.get("railway:ref"), tags.get("ref:station"))) else "osm_only",
    }


async def resolve_station_identity(name: str, latitude: float, longitude: float) -> dict[str, Any]:
    query = f'[out:json][timeout:20];nwr(around:1500,{latitude},{longitude})[railway~"^(station|halt)$"];out center tags;'
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        response = await client.post(OVERPASS_URL, data={"data": query}, headers={"User-Agent": "rail-infrastructure-intelligence/1.3"})
        response.raise_for_status()
        return select_station_identity(response.json().get("elements", []), name, latitude, longitude)
