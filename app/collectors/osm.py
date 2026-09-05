from math import asin, cos, radians, sin, sqrt
import re
from typing import Any

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.collectors.openstation import FRIEDBERG_EVA, FRIEDBERG_RIL
from app.identity import FRIEDBERG_HESS, is_friedberg_hess


ROOT_OBJECT_KEY = "FRI-NETEX-dhid:de:06440:6401:EdB"


def _coordinates(element: dict[str, Any]) -> tuple[float | None, float | None]:
    center = element.get("center", {})
    return element.get("lat", center.get("lat")), element.get("lon", center.get("lon"))


def _line_length_m(geometry: list[dict[str, float]]) -> float | None:
    if len(geometry) < 2:
        return None
    total = 0.0
    for start, end in zip(geometry, geometry[1:]):
        lat1, lon1, lat2, lon2 = map(radians, (start["lat"], start["lon"], end["lat"], end["lon"]))
        dlat, dlon = lat2 - lat1, lon2 - lon1
        value = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
        total += 6371000 * 2 * asin(sqrt(value))
    return round(total, 1)


def _platform_height_mm(value: str | None) -> int | None:
    if not value:
        return None
    match = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(m|cm|mm)?\s*", value.casefold())
    if not match:
        return None
    number, unit = float(match.group(1).replace(",", ".")), match.group(2) or "m"
    return round(number * {"m": 1000, "cm": 10, "mm": 1}[unit])


def _value(value: Any) -> Any:
    normalized = str(value).casefold()
    if normalized in {"yes", "true", "no", "false"}:
        return normalized in {"yes", "true"}
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return value


def parse_osm_friedberg(payload: dict[str, Any]) -> list[CollectedObservation]:
    elements = payload.get("elements", [])
    stations = [item for item in elements if item.get("tags", {}).get("ref:ibnr") == FRIEDBERG_EVA]
    if not stations or any(not is_friedberg_hess(item.get("tags", {}).get("name", "")) for item in stations):
        return []
    if any(item.get("tags", {}).get("railway:ref") not in (None, FRIEDBERG_RIL) for item in stations):
        return []
    if any(item.get("tags", {}).get("ref:station") != str(FRIEDBERG_HESS.station_number) for item in stations):
        return []
    station = next((item for item in stations if item.get("type") == "node"), stations[0])
    observations: list[CollectedObservation] = []

    def append(element: dict[str, Any], object_key: str, object_type: str,
               attributes: dict[str, Any], parent: str | None = None,
               derived_attributes: set[str] | None = None) -> None:
        osm_type, osm_id = element["type"], element["id"]
        latitude, longitude = _coordinates(element)
        attributes.update(latitude=latitude, longitude=longitude)
        metadata = {"osm_type": osm_type, "osm_id": osm_id, "station_uic_ref": FRIEDBERG_EVA}
        if parent:
            metadata["parent_object_key"] = parent
            metadata["association_method"] = "spatial_proximity_to_identity_verified_station"
        for attribute, value in attributes.items():
            if value is not None:
                observations.append(CollectedObservation(
                    object_key=object_key, object_type=object_type, attribute=attribute, value=_value(value),
                    unit={"latitude": "degree", "longitude": "degree", "platform_height": "mm",
                          "construction_length": "m", "start_coordinates": "EPSG:4326",
                          "end_coordinates": "EPSG:4326"}.get(attribute),
                    source_key="openstreetmap", source_url=f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
                    source_publisher="OpenStreetMap contributors", source_type="community_geodata",
                    quality_class="D", is_derived=attribute in (derived_attributes or set()),
                    method="geometry_calculation" if attribute in (derived_attributes or set()) else "source",
                    metadata=metadata))

    tags = station.get("tags", {})
    append(station, ROOT_OBJECT_KEY, "stop_place", {
        "name": tags.get("name"), "eva": tags.get("ref:ibnr"), "uic_ref": tags.get("uic_ref"),
        "station_number": tags.get("ref:station"), "ril": tags.get("railway:ref") or tags.get("ref")})

    for element in elements:
        if element is station or "type" not in element or "id" not in element:
            continue
        tags = element.get("tags", {})
        derived_attributes: set[str] = set()
        if tags.get("railway") in {"platform", "platform_edge"}:
            kind = tags["railway"]
            attributes = {"name": tags.get("name"), "public_code": tags.get("ref"),
                          "wheelchair": tags.get("wheelchair"), "tactile_paving": tags.get("tactile_paving")}
            height = _platform_height_mm(tags.get("height"))
            if height is not None:
                attributes["platform_height"] = height
            geometry = element.get("geometry", [])
            if kind == "platform_edge" and len(geometry) >= 2:
                attributes.update(
                    construction_length=_line_length_m(geometry),
                    start_coordinates={"latitude": geometry[0]["lat"], "longitude": geometry[0]["lon"]},
                    end_coordinates={"latitude": geometry[-1]["lat"], "longitude": geometry[-1]["lon"]},
                )
                derived_attributes = {"construction_length", "start_coordinates", "end_coordinates"}
        elif tags.get("railway") in {"subway_entrance", "station_entrance"} or tags.get("entrance"):
            kind = "entrance"
            attributes = {"name": tags.get("name"), "entrance": tags.get("entrance"),
                          "wheelchair": tags.get("wheelchair")}
        elif tags.get("highway") == "elevator":
            kind = "equipment"
            attributes = {"name": tags.get("name"), "equipment_type": "LiftEquipment",
                          "wheelchair": tags.get("wheelchair")}
        elif tags.get("amenity") in {"shelter", "toilets", "bicycle_parking", "bench"}:
            kind = "equipment"
            attributes = {"name": tags.get("name"), "equipment_type": tags["amenity"]}
        else:
            continue
        object_key = f"FRI-OSM-{element['type']}-{element['id']}"
        if kind == "platform_edge" and re.fullmatch(r"\d+[a-zA-Z]?", tags.get("ref", "")):
            object_key = f"FRI-PE-{tags['ref'].upper()}"
        append(element, object_key, kind, attributes, ROOT_OBJECT_KEY, derived_attributes)
    return observations


class OpenStreetMapCollector(Collector):
    name = "openstreetmap"
    endpoint = "https://overpass-api.de/api/interpreter"
    query = f'''[out:json][timeout:30];
nwr["railway"="station"]["ref:ibnr"="{FRIEDBERG_EVA}"]["ref:station"="{FRIEDBERG_HESS.station_number}"]["railway:ref"="{FRIEDBERG_RIL}"]->.station;
(.station;
nwr(around.station:250)["railway"~"^(platform|platform_edge|station_entrance|subway_entrance)$"];
nwr(around.station:120)["entrance"];
nwr(around.station:200)["highway"="elevator"];
nwr(around.station:150)["amenity"~"^(shelter|toilets|bicycle_parking|bench)$"];
); out geom tags;'''

    async def fetch(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
            response = await client.post(self.endpoint, data={"data": self.query},
                                         headers={"User-Agent": "rail-infrastructure-intelligence/1.1"})
            response.raise_for_status()
            return response.json()

    async def collect(self, station: str) -> list[CollectedObservation]:
        if not is_friedberg_hess(station, FRIEDBERG_HESS.station_number):
            return []
        return parse_osm_friedberg(await self.fetch())
