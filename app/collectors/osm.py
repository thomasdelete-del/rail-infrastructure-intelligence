from typing import Any

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.collectors.openstation import FRIEDBERG_EVA, FRIEDBERG_RIL
from app.identity import FRIEDBERG_HESS, is_friedberg_hess


ROOT_OBJECT_KEY = "FRI-NETEX-dhid:de:06440:6401:EdB"


def _coordinates(element: dict[str, Any]) -> tuple[float | None, float | None]:
    center = element.get("center", {})
    return element.get("lat", center.get("lat")), element.get("lon", center.get("lon"))


def _value(value: Any) -> Any:
    return {"yes": True, "true": True, "no": False, "false": False}.get(str(value).casefold(), value)


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
               attributes: dict[str, Any], parent: str | None = None) -> None:
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
                    unit="degree" if attribute in {"latitude", "longitude"} else None,
                    source_key="openstreetmap", source_url=f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
                    source_publisher="OpenStreetMap contributors", source_type="community_geodata",
                    quality_class="D", metadata=metadata))

    tags = station.get("tags", {})
    append(station, ROOT_OBJECT_KEY, "stop_place", {
        "name": tags.get("name"), "eva": tags.get("ref:ibnr"), "uic_ref": tags.get("uic_ref"),
        "station_number": tags.get("ref:station"), "ril": tags.get("railway:ref") or tags.get("ref")})

    for element in elements:
        if element is station or "type" not in element or "id" not in element:
            continue
        tags = element.get("tags", {})
        if tags.get("railway") in {"platform", "platform_edge"}:
            kind = tags["railway"]
            attributes = {"name": tags.get("name"), "public_code": tags.get("ref"),
                          "wheelchair": tags.get("wheelchair"), "tactile_paving": tags.get("tactile_paving")}
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
        append(element, f"FRI-OSM-{element['type']}-{element['id']}", kind, attributes, ROOT_OBJECT_KEY)
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
); out center tags;'''

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
