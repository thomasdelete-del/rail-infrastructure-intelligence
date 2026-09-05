import json
import os
from datetime import datetime
from typing import Any

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.collectors.openstation import FRIEDBERG_RIL
from app.identity import FRIEDBERG_HESS, is_friedberg_hess


ISR_ENDPOINT = "https://apis.deutschebahn.com/db-api-marketplace/apis/isr/v1/bahnsteige"
FRIEDBERG_PLATFORM_TRACKS = {"1", "1a", "2", "4", "5", "7", "8", "10", "11", "12"}


def _number(value: Any) -> int | float | None:
    if value is None or str(value).strip() in {"", "-"}:
        return None
    try:
        number = float(str(value).replace(",", "."))
    except ValueError:
        return None
    return int(number) if number.is_integer() else number


def _source_date(value: Any) -> str | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y.%m.%d %H:%M:%S").date().isoformat()
    except ValueError:
        return None


def parse_isr_platforms(data: dict[str, Any]) -> list[CollectedObservation]:
    observations: list[CollectedObservation] = []
    for platform in data.get("items", []):
        name = str(platform.get("bst_stelle_name") or "")
        ril = str(platform.get("bst_rl100") or "")
        track = str(platform.get("alg_gleisnummer_verk_de") or "").strip()
        if ril != FRIEDBERG_RIL or not is_friedberg_hess(name) or track not in FRIEDBERG_PLATFORM_TRACKS:
            continue
        usable_length = _number(platform.get("alg_max_nutzlaenge_de"))
        if usable_length is None:
            continue
        platform_id = platform.get("bste_id")
        source_date = _source_date(platform.get("zeitscheibe"))
        metadata = {
            "isr_platform_id": platform_id,
            "station_name": name,
            "ril": ril,
            "traffic_track": track,
            "operational_track": platform.get("alg_gleisnummer_betr_de"),
            "timetable_year": platform.get("jfpl"),
            "load_id": platform.get("lade_id"),
        }
        observations.append(CollectedObservation(
            object_key=f"FRI-PE-{track.upper()}", object_type="platform_edge",
            attribute="usable_length", value=usable_length, unit="m",
            source_key="db-infrago-isr", source_url=ISR_ENDPOINT,
            source_publisher="DB InfraGO AG", source_type="primary_api",
            source_date=source_date, quality_class="A", method="source",
            note="Maximum operational platform usable length published by ISR.",
            metadata={key: value for key, value in metadata.items() if value is not None},
        ))
    return observations


class ISRCollector(Collector):
    name = "db_infrago_isr"
    endpoint = ISR_ENDPOINT

    def __init__(self, client_id: str | None = None, api_key: str | None = None):
        self.client_id = client_id or os.getenv("DB_API_CLIENT_ID")
        self.api_key = api_key or os.getenv("DB_API_KEY")

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.api_key)

    async def collect(self, station: str) -> list[CollectedObservation]:
        if not self.configured:
            raise RuntimeError("ISR requires DB_API_CLIENT_ID and DB_API_KEY")
        if not is_friedberg_hess(station, FRIEDBERG_HESS.station_number):
            return []
        query = json.dumps({"bst_rl100": {"$eq": FRIEDBERG_RIL}}, separators=(",", ":"))
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                self.endpoint,
                params={"q": query, "l": 500, "o": 0},
                headers={"DB-Client-ID": self.client_id, "DB-Api-Key": self.api_key},
            )
            response.raise_for_status()
            return parse_isr_platforms(response.json())
