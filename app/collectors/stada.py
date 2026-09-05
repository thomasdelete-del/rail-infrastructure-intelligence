import os
import re
from typing import Any

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.collectors.openstation import FRIEDBERG_EVA, FRIEDBERG_RIL
from app.collectors.osm import ROOT_OBJECT_KEY
from app.identity import FRIEDBERG_HESS, is_friedberg_hess


def _snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


def parse_stada_station(data: dict[str, Any]) -> list[CollectedObservation]:
    if "result" in data and isinstance(data["result"], list):
        data = next((item for item in data["result"] if str(item.get("number")) == str(FRIEDBERG_HESS.station_number)), {})
    number, name = data.get("number"), data.get("name", "")
    try:
        number = int(number)
    except (TypeError, ValueError):
        return []
    if number != FRIEDBERG_HESS.station_number or not is_friedberg_hess(name, number):
        return []
    evas, rils = data.get("evaNumbers", []), data.get("ril100Identifiers", [])
    if not any(str(item.get("number")) == FRIEDBERG_EVA for item in evas):
        return []
    if rils and not any(item.get("rilIdentifier") == FRIEDBERG_RIL for item in rils):
        return []
    coordinates = next((item.get("geographicCoordinates", {}).get("coordinates") for item in evas if item.get("isMain")), None)
    address = data.get("mailingAddress") or {}
    attributes = {
        "name": name, "station_number": number, "category": data.get("category"), "eva": FRIEDBERG_EVA,
        "ril": next((item.get("rilIdentifier") for item in rils if item.get("isMain")), FRIEDBERG_RIL),
        "longitude": coordinates[0] if coordinates and len(coordinates) > 1 else None,
        "latitude": coordinates[1] if coordinates and len(coordinates) > 1 else None,
        "street": address.get("street"), "postal_code": address.get("zipcode"), "city": address.get("city"),
    }
    for key in ("hasParking", "hasBicycleParking", "hasLocalPublicTransport", "hasPublicFacilities",
                "hasLockerSystem", "hasTaxiRank", "hasTravelNecessities", "hasSteplessAccess",
                "hasMobilityService", "hasWiFi"):
        if key in data:
            attributes[_snake(key)] = data[key]
    url = f"https://apis.deutschebahn.com/db-api-marketplace/apis/station-data/v2/stations/{number}"
    return [CollectedObservation(
        object_key=ROOT_OBJECT_KEY, object_type="stop_place", attribute=attribute, value=value,
        unit="degree" if attribute in {"latitude", "longitude"} else None,
        source_key="db-infrago-stada", source_url=url, source_publisher="DB InfraGO AG",
        source_type="primary_api", quality_class="A",
        metadata={"station_number": number, "eva": FRIEDBERG_EVA, "ril": FRIEDBERG_RIL})
        for attribute, value in attributes.items() if value is not None]


class StaDaCollector(Collector):
    name = "db_infrago_stada"
    endpoint = f"https://apis.deutschebahn.com/db-api-marketplace/apis/station-data/v2/stations/{FRIEDBERG_HESS.station_number}"

    def __init__(self, client_id: str | None = None, api_key: str | None = None):
        self.client_id = client_id or os.getenv("DB_API_CLIENT_ID")
        self.api_key = api_key or os.getenv("DB_API_KEY")

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.api_key)

    async def collect(self, station: str) -> list[CollectedObservation]:
        if not self.configured:
            raise RuntimeError("StaDa requires DB_API_CLIENT_ID and DB_API_KEY")
        if not is_friedberg_hess(station, FRIEDBERG_HESS.station_number):
            return []
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(self.endpoint, headers={"DB-Client-ID": self.client_id, "DB-Api-Key": self.api_key})
            response.raise_for_status()
            return parse_stada_station(response.json())
