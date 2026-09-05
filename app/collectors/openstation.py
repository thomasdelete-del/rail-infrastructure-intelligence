import re
from io import BytesIO
from typing import Any
from xml.etree.ElementTree import Element, iterparse

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.identity import FRIEDBERG_HESS, is_friedberg_hess

FRIEDBERG_EVA = "8000111"
FRIEDBERG_RIL = "FFG"


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def direct_child(element: Element, name: str) -> Element | None:
    return next((child for child in element if local_name(child.tag) == name), None)


def direct_text(element: Element, name: str) -> str | None:
    child = direct_child(element, name)
    if child is None:
        return None
    # EPIP commonly repeats multilingual text in a nested <Text> element.
    # Prefer the element's own text so "NameName" is never manufactured.
    value = (child.text or "").strip() or "".join(child.itertext()).strip()
    return value or None


def nested_text(element: Element, path: tuple[str, ...]) -> str | None:
    current = element
    for name in path:
        current = direct_child(current, name)
        if current is None:
            return None
    value = "".join(current.itertext()).strip()
    return value or None


def key_values(element: Element) -> dict[str, str]:
    result: dict[str, str] = {}
    key_list = direct_child(element, "keyList")
    if key_list is not None:
        for pair in key_list:
            key, value = direct_text(pair, "Key"), direct_text(pair, "Value")
            if local_name(pair.tag) == "KeyValue" and key and value:
                result[key] = value
    return result


def source_value(value: str) -> Any:
    value = value.strip()
    if value.casefold() in {"true", "false"}:
        return value.casefold() == "true"
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if re.fullmatch(r"-?(?:\d+\.\d*|\d*\.\d+)", value):
        return float(value)
    return value


def snake_case(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def coordinates(element: Element) -> tuple[float | None, float | None]:
    latitude = nested_text(element, ("Centroid", "Location", "Latitude"))
    longitude = nested_text(element, ("Centroid", "Location", "Longitude"))
    return (float(latitude) if latitude else None, float(longitude) if longitude else None)


def accessibility(element: Element) -> dict[str, Any]:
    assessment = direct_child(element, "AccessibilityAssessment")
    if assessment is None:
        return {}
    result: dict[str, Any] = {}
    mobility = direct_text(assessment, "MobilityImpairedAccess")
    if mobility is not None:
        result["mobility_impaired_access"] = source_value(mobility)
    limitations = direct_child(assessment, "limitations")
    limitation = next(iter(limitations), None) if limitations is not None else None
    if limitation is not None:
        for child in limitation:
            if len(child) == 0 and child.text and child.text.strip():
                result[snake_case(local_name(child.tag))] = source_value(child.text)
    return result


def strict_friedberg_identity(stop_place: Element) -> dict[str, Any] | None:
    name, private_code = direct_text(stop_place, "Name"), direct_text(stop_place, "PrivateCode")
    keys = key_values(stop_place)
    try:
        station_number = int(private_code) if private_code else None
    except ValueError:
        return None
    if not name or not is_friedberg_hess(name, station_number):
        return None
    if station_number != FRIEDBERG_HESS.station_number:
        return None
    if keys.get("EVA") not in (None, FRIEDBERG_EVA) or keys.get("RIL") not in (None, FRIEDBERG_RIL):
        return None
    return {"name": name, "station_number": station_number, "keys": keys}


def entity_record(element: Element, object_type: str, parent_id: str | None, attributes: dict[str, Any]) -> dict[str, Any] | None:
    netex_id = element.attrib.get("id")
    if not netex_id:
        return None
    name = direct_text(element, "Name")
    if name is not None:
        attributes = {"name": name, **attributes}
    public_code = direct_text(element, "PublicCode")
    if public_code is not None:
        attributes["public_code"] = source_value(public_code)
    latitude, longitude = coordinates(element)
    if latitude is not None:
        attributes["latitude"] = latitude
    if longitude is not None:
        attributes["longitude"] = longitude
    attributes.update(accessibility(element))
    return {"netex_id": netex_id, "netex_type": local_name(element.tag), "object_type": object_type,
            "parent_netex_id": parent_id, "attributes": attributes}


def equipment_attributes(element: Element) -> dict[str, Any]:
    attributes: dict[str, Any] = {"equipment_type": local_name(element.tag)}
    excluded = {"keyList", "privateCodes", "PrivateCode", "Name", "TopEnd", "BottomEnd"}
    for child in element:
        tag = local_name(child.tag)
        if tag in excluded or tag.endswith("Ref") or len(child) != 0:
            continue
        if child.text and child.text.strip():
            attributes[snake_case(tag)] = source_value(child.text)
    return attributes


def parse_stop_place(stop_place: Element) -> dict[str, Any] | None:
    identity = strict_friedberg_identity(stop_place)
    stop_id = stop_place.attrib.get("id")
    if identity is None or not stop_id:
        return None
    attrs: dict[str, Any] = {"name": identity["name"], "station_number": identity["station_number"]}
    for key in ("EVA", "RIL", "DBINFRAGO_STATION_CATEGORY", "DBINFRAGO_PRICE_CATEGORY"):
        if key in identity["keys"]:
            attrs[snake_case(key)] = source_value(identity["keys"][key])
    for tag in ("PublicUse", "Gated", "Lighting", "SiteType", "StopPlaceType", "TransportMode"):
        value = direct_text(stop_place, tag)
        if value is not None:
            attrs[snake_case(tag)] = source_value(value)
    latitude, longitude = coordinates(stop_place)
    if latitude is not None:
        attrs["latitude"] = latitude
    if longitude is not None:
        attrs["longitude"] = longitude
    attrs.update(accessibility(stop_place))
    entities = [{"netex_id": stop_id, "netex_type": "StopPlace", "object_type": "stop_place",
                 "parent_netex_id": None, "attributes": attrs}]

    quays = direct_child(stop_place, "quays")
    quay_items = [item for item in quays if local_name(item.tag) == "Quay"] if quays is not None else []
    platform_ids = {
        item.attrib["id"] for item in quay_items
        if direct_text(item, "QuayType") == "railIslandPlatform" and item.attrib.get("id")
    }
    for quay in quay_items:
        quay_type = direct_text(quay, "QuayType")
        object_type = "platform_edge" if quay_type == "railPlatform" else "platform"
        parent_id = stop_id
        if object_type == "platform_edge":
            parent_id = next(
                (candidate for candidate in platform_ids if quay.attrib.get("id", "").startswith(candidate + ":")),
                stop_id,
            )
        quay_attrs = {"quay_type": quay_type} if quay_type is not None else {}
        record = entity_record(quay, object_type, parent_id, quay_attrs)
        if record:
            entities.append(record)

    entrances = direct_child(stop_place, "entrances")
    for entrance in (item for item in entrances if local_name(item.tag) == "Entrance") if entrances is not None else ():
        entrance_attrs = {}
        for tag in ("PublicUse", "Gated", "IsExternal", "IsEntry", "IsExit"):
            value = direct_text(entrance, tag)
            if value is not None:
                entrance_attrs[snake_case(tag)] = source_value(value)
        record = entity_record(entrance, "entrance", stop_id, entrance_attrs)
        if record:
            entities.append(record)

    equipments = direct_child(stop_place, "placeEquipments")
    for equipment in equipments if equipments is not None else ():
        if local_name(equipment.tag).endswith("Equipment"):
            record = entity_record(equipment, "equipment", stop_id, equipment_attributes(equipment))
            if record:
                entities.append(record)
    return {"netex_id": stop_id, "name": identity["name"], "entities": entities}


def extract_friedberg_stop_places(xml: bytes) -> list[dict[str, Any]]:
    """Stream NeTEx and return only identity-verified Friedberg (Hess) data."""
    matches = []
    for _, element in iterparse(BytesIO(xml), events=("end",)):
        if local_name(element.tag) == "StopPlace":
            record = parse_stop_place(element)
            if record is not None:
                matches.append(record)
            element.clear()
    return matches


class OpenStationCollector(Collector):
    name = "openstation_netex"
    netex_url = "https://bahnhof.de/daten/netex"
    source_key = "db-infrago-openstation-netex"

    async def fetch_netex(self) -> bytes:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            response = await client.get(self.netex_url, headers={"Accept-Encoding": "gzip"})
            response.raise_for_status()
            return response.content

    async def collect(self, station: str) -> list[CollectedObservation]:
        if not is_friedberg_hess(station, FRIEDBERG_HESS.station_number):
            return []
        observations: list[CollectedObservation] = []
        for record in extract_friedberg_stop_places(await self.fetch_netex()):
            for entity in record["entities"]:
                object_key = f"FRI-NETEX-{entity['netex_id']}"
                if entity["object_type"] == "platform_edge":
                    track = str(entity["attributes"].get("public_code") or entity["attributes"].get("name", ""))
                    if re.fullmatch(r"\d+[a-zA-Z]?", track):
                        object_key = f"FRI-PE-{track.upper()}"
                common = dict(object_key=object_key, object_type=entity["object_type"],
                              source_key=self.source_key, source_url=self.netex_url,
                              source_publisher="DB InfraGO AG", source_type="primary_api", quality_class="A",
                              metadata={"netex_id": entity["netex_id"], "netex_type": entity["netex_type"],
                                        "parent_netex_id": entity["parent_netex_id"], "station_netex_id": record["netex_id"]})
                for attribute, value in entity["attributes"].items():
                    unit = "degree" if attribute in {"latitude", "longitude"} else None
                    observations.append(CollectedObservation(attribute=attribute, value=value, unit=unit, **common))
        return observations
