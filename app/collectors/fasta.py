import os
from typing import Any

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.collectors.osm import ROOT_OBJECT_KEY
from app.identity import FRIEDBERG_HESS, is_friedberg_hess


def parse_fasta_facilities(data: dict[str, Any] | list[dict[str, Any]]) -> list[CollectedObservation]:
    facilities = data if isinstance(data, list) else data.get("facilities", [])
    observations: list[CollectedObservation] = []
    for facility in facilities:
        if str(facility.get("stationnumber")) != str(FRIEDBERG_HESS.station_number) or facility.get("equipmentnumber") is None:
            continue
        number = facility["equipmentnumber"]
        attributes = {"name": facility.get("description"),
                      "equipment_type": "LiftEquipment" if facility.get("type") == "ELEVATOR" else "EscalatorEquipment",
                      "operational_state": facility.get("state"), "latitude": facility.get("geocoordY"),
                      "longitude": facility.get("geocoordX")}
        for attribute, value in attributes.items():
            if value is not None:
                observations.append(CollectedObservation(
                    object_key=f"FRI-FASTA-{number}", object_type="equipment", attribute=attribute, value=value,
                    unit="degree" if attribute in {"latitude", "longitude"} else None,
                    source_key="db-infrago-fasta",
                    source_url=f"https://apis.deutschebahn.com/db-api-marketplace/apis/fasta/v2/facilities/{number}",
                    source_publisher="DB InfraGO AG", source_type="primary_realtime_api", quality_class="A",
                    metadata={"equipment_number": number, "station_number": FRIEDBERG_HESS.station_number,
                              "parent_object_key": ROOT_OBJECT_KEY}))
    return observations


class FaStaCollector(Collector):
    name = "db_infrago_fasta"
    endpoint = f"https://apis.deutschebahn.com/db-api-marketplace/apis/fasta/v2/stations/{FRIEDBERG_HESS.station_number}"

    def __init__(self, client_id: str | None = None, api_key: str | None = None):
        self.client_id = client_id or os.getenv("DB_API_CLIENT_ID")
        self.api_key = api_key or os.getenv("DB_API_KEY")

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.api_key)

    async def collect(self, station: str) -> list[CollectedObservation]:
        if not self.configured:
            raise RuntimeError("FaSta requires DB_API_CLIENT_ID and DB_API_KEY")
        if not is_friedberg_hess(station, FRIEDBERG_HESS.station_number):
            return []
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(self.endpoint, headers={"DB-Client-ID": self.client_id, "DB-Api-Key": self.api_key})
            if response.status_code == 404:
                return []
            response.raise_for_status()
            return parse_fasta_facilities(response.json())
