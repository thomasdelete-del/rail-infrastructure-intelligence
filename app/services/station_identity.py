from __future__ import annotations

import asyncio
import os
from difflib import SequenceMatcher
from math import asin, cos, radians, sin, sqrt
from time import monotonic
from typing import Any

import httpx

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
_NETEX_CACHE: tuple[float, bytes] | None = None
_NETEX_CACHE_LOCK = asyncio.Lock()
_STADA_CACHE: tuple[float, list[dict[str, Any]]] | None = None
_STADA_CACHE_LOCK = asyncio.Lock()
STADA_STATIONS_URL = "https://apis.deutschebahn.com/db-api-marketplace/apis/station-data/v2/stations"


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


async def resolve_netex_identity(name: str, latitude: float, longitude: float) -> dict[str, Any]:
    """Resolve the authoritative station identity from the NeTEx delivery."""
    from app.collectors.openstation import select_station_identity_from_netex
    return select_station_identity_from_netex(await _netex_xml(), name, latitude, longitude)


async def _netex_xml() -> bytes:
    """Download the NeTEx delivery once per hour for identity operations."""
    global _NETEX_CACHE
    from app.collectors.openstation import OpenStationCollector
    async with _NETEX_CACHE_LOCK:
        if _NETEX_CACHE is None or monotonic() - _NETEX_CACHE[0] > 3600:
            _NETEX_CACHE = (monotonic(), await OpenStationCollector().fetch_netex())
        return _NETEX_CACHE[1]


async def netex_xml() -> bytes:
    """Public cached NeTEx delivery for identity and infrastructure consumers."""
    return await _netex_xml()


async def search_netex_stations(query: str, limit: int = 12) -> list[dict[str, Any]]:
    """Return ranked DB NeTEx stations for the station picker."""
    from app.collectors.openstation import extract_station_identities
    needle = " ".join(query.casefold().split())
    matches = []
    for identity in extract_station_identities(await _netex_xml()):
        name = " ".join(identity["name"].casefold().split())
        similarity = SequenceMatcher(None, needle, name).ratio()
        if needle not in name and similarity < 0.55:
            continue
        if identity.get("latitude") is None or identity.get("longitude") is None:
            continue
        prefix_bonus = 0.25 if name.startswith(needle) else 0
        matches.append((similarity + prefix_bonus, identity))
    matches.sort(key=lambda item: (-item[0], item[1]["name"]))
    return [identity for _, identity in matches[:limit]]


def normalize_stada_station(station: dict[str, Any]) -> dict[str, Any] | None:
    """Reduce one StaDa record to the fields needed by the station picker."""
    name, number = station.get("name"), station.get("number")
    if not name or number is None:
        return None
    evas = station.get("evaNumbers") or []
    rils = station.get("ril100Identifiers") or []
    main_eva = next((item for item in evas if item.get("isMain")), evas[0] if evas else {})
    main_ril = next((item for item in rils if item.get("isMain")), rils[0] if rils else {})
    coordinates = (main_eva.get("geographicCoordinates") or {}).get("coordinates") or []
    return {
        "station_number": number,
        "name": name,
        "eva": main_eva.get("number"),
        "ril": main_ril.get("rilIdentifier"),
        "longitude": coordinates[0] if len(coordinates) > 1 else None,
        "latitude": coordinates[1] if len(coordinates) > 1 else None,
    }


async def stada_station_list() -> list[dict[str, Any]]:
    """Load StaDa master data at most once daily, as required for static data."""
    global _STADA_CACHE
    async with _STADA_CACHE_LOCK:
        if _STADA_CACHE is not None and monotonic() - _STADA_CACHE[0] < 86400:
            return _STADA_CACHE[1]
        client_id, api_key = os.getenv("DB_API_CLIENT_ID"), os.getenv("DB_API_KEY")
        if not client_id or not api_key:
            raise RuntimeError("StaDa requires DB_API_CLIENT_ID and DB_API_KEY")
        headers = {"DB-Client-ID": client_id, "DB-Api-Key": api_key}
        async with httpx.AsyncClient(timeout=60, headers=headers) as client:
            response = await client.get(STADA_STATIONS_URL, params={"limit": 10000})
            response.raise_for_status()
        stations = [item for raw in response.json().get("result", []) if (item := normalize_stada_station(raw))]
        stations.sort(key=lambda item: item["name"].casefold())
        _STADA_CACHE = (monotonic(), stations)
        return stations


async def resolve_stada_identity(name: str, latitude: float, longitude: float) -> dict[str, Any]:
    """Resolve a station against StaDa master data using name and proximity."""
    target = _normalized_name(name)
    candidates = []
    for station in await stada_station_list():
        similarity = SequenceMatcher(None, target, _normalized_name(station["name"])).ratio()
        if station.get("latitude") is None or station.get("longitude") is None:
            distance = 999999.0
        else:
            distance = _distance_m(latitude, longitude, float(station["latitude"]), float(station["longitude"]))
        candidates.append((distance - similarity * 350, distance, similarity, station))
    candidates.sort(key=lambda item: item[0])
    if not candidates or candidates[0][1] > 1500:
        raise LookupError("No StaDa station found within 1.5 km")
    result = dict(candidates[0][3])
    result.update(matched_name=result["name"], distance_m=round(candidates[0][1], 1), name_similarity=round(candidates[0][2], 3))
    return result


def prioritize_station_identity(
    netex: dict[str, Any] | None, european: dict[str, Any] | None, osm: dict[str, Any] | None,
    stada: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply the fixed authority order StaDa -> NeTEx -> European register -> OSM."""
    sources = (("stada", stada), ("netex", netex), ("european_register", european), ("openstreetmap", osm))
    primary_name, primary = next(((key, value) for key, value in sources if value), (None, None))
    if primary is None:
        raise LookupError("No station identity source returned a match")
    result: dict[str, Any] = {}
    for attribute in ("name", "matched_name", "netex_id", "dhid", "station_number", "eva", "ril", "latitude", "longitude", "osm_type", "osm_id"):
        result[attribute] = next((value.get(attribute) for _, value in sources if value and value.get(attribute) not in (None, "")), None)
    result["matched_name"] = result.get("name") or result.get("matched_name")
    result["identity_source"] = primary_name
    result["identity_status"] = "identified" if any(result.get(key) for key in ("station_number", "eva", "ril", "dhid")) else "geographic_only"
    result["source_priority"] = ["db_infrago_stada", "db_infrago_netex", "era_rinf", "openstreetmap"]
    return result
