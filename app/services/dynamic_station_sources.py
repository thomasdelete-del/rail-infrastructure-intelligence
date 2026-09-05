from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx


def normalize_stada(data: dict[str, Any], station_number: str) -> dict[str, Any] | None:
    records = data.get("result", []) if isinstance(data.get("result"), list) else [data]
    station = next((item for item in records if str(item.get("number")) == station_number), None)
    if not station:
        return None
    return {key: station.get(key) for key in ("number", "name", "category", "evaNumbers", "ril100Identifiers", "mailingAddress", "hasSteplessAccess", "hasWiFi") if station.get(key) is not None}


def normalize_fasta(data: dict[str, Any] | list[dict[str, Any]], station_number: str) -> list[dict[str, Any]]:
    facilities = data if isinstance(data, list) else data.get("facilities", [])
    return [{key: item.get(key) for key in ("equipmentnumber", "type", "state", "description", "geocoordX", "geocoordY")}
            for item in facilities if str(item.get("stationnumber")) == station_number]


async def collect_db_station_sources(station_number: str | None) -> dict[str, Any]:
    client_id, api_key = os.getenv("DB_API_CLIENT_ID"), os.getenv("DB_API_KEY")
    if not station_number:
        return {"stada": {"status": "identity_missing"}, "fasta": {"status": "identity_missing"}}
    if not client_id or not api_key:
        return {"stada": {"status": "access_missing"}, "fasta": {"status": "access_missing"}}
    headers = {"DB-Client-ID": client_id, "DB-Api-Key": api_key}
    base = "https://apis.deutschebahn.com/db-api-marketplace/apis"
    async with httpx.AsyncClient(timeout=30, headers=headers) as client:
        stada_response, fasta_response = await asyncio.gather(
            client.get(f"{base}/station-data/v2/stations/{station_number}"),
            client.get(f"{base}/fasta/v2/stations/{station_number}"), return_exceptions=True)
    stada = normalize_stada(stada_response.json(), station_number) if isinstance(stada_response, httpx.Response) and stada_response.is_success else None
    fasta = normalize_fasta(fasta_response.json(), station_number) if isinstance(fasta_response, httpx.Response) and fasta_response.is_success else []
    return {"stada": {"status": "active" if stada else "not_found", "station": stada},
            "fasta": {"status": "active", "facilities": fasta, "facility_count": len(fasta)}}
