import asyncio
import csv
import hashlib
import io
import json
from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlalchemy import text

from app.database import get_engine

ISR_URL = "https://geoviewer.deutschebahn.com/geoviewer-geoserver/ows"
RINF_URL = "https://graph.data.era.europa.eu/repositories/rinf-plus"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BUSINESS_COLUMNS = (
    "eva_nummer", "ds100_rl100", "bahnhofsname", "streckennummer",
    "osm_bahnsteig_ref", "isr_gleisnummer_betrieb", "isr_gleisnummer_verkehr",
    "isr_systemhoehe_cm", "isr_bahnsteignutzlaenge_m", "rinf_uopid",
    "rinf_platform_id", "rinf_track_id", "match_methode", "anmerkungen",
)


def rinf_uopid(rl100: str) -> str:
    return "DE0" + rl100.strip().upper().zfill(4)


def _csv_rows(payload: str) -> list[dict[str, str]]:
    sample = payload[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t,")
    except csv.Error:
        dialect = csv.excel
    return [
        {str(key).lstrip("\ufeff").strip(): (value or "").strip() for key, value in row.items()}
        for row in csv.DictReader(io.StringIO(payload), dialect=dialect)
    ]


def _number(value: str | None) -> Decimal | None:
    if not value:
        return None
    try:
        return Decimal(value.replace(".", "").replace(",", ".")) if "," in value else Decimal(value)
    except InvalidOperation:
        return None


def _hash(row: dict[str, Any]) -> str:
    normalized = {key: str(row.get(key)) if isinstance(row.get(key), Decimal) else row.get(key) for key in BUSINESS_COLUMNS}
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


async def fetch_operational_points(client: httpx.AsyncClient, year: int) -> list[dict[str, str]]:
    response = await client.get(ISR_URL, params={
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": "ISR:ISR_V_GEO_BETRIEBSSTELLEN_PUNKT", "outputFormat": "csv", "count": "15000",
        "viewParams": f"LANG:DE;JAHR:{year};STRECKENAUSWAHL:DB Strecken",
    })
    response.raise_for_status()
    return [row for row in _csv_rows(response.text) if row.get("ALG_REISENDENAUFKOMM")]


async def fetch_isr_platforms(client: httpx.AsyncClient, stel_id: str) -> list[dict[str, str]]:
    response = await client.get(ISR_URL, params={
        "service": "WFS", "version": "2.0.0", "request": "GetFeature",
        "typeNames": "ISR:ISR_V_GEO_BAHNSTEIG_ISR", "outputFormat": "csv",
        "viewParams": f"STEL_ID:{stel_id}",
    })
    response.raise_for_status()
    return _csv_rows(response.text)


async def fetch_rinf_station(client: httpx.AsyncClient, uopid: str, year: int) -> list[dict[str, str]]:
    query = f'''PREFIX era: <http://data.europa.eu/949/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?trackId ?platformId WHERE {{
 ?op a era:OperationalPoint ; era:uopid "{uopid}" ; rdfs:label ?opLabel ; era:hasPart ?track .
 FILTER(CONTAINS(STR(?opLabel), "{year}"))
 ?track era:trackId ?trackId ; era:hasPart ?pe .
 ?pe era:platformId ?platformId ; era:validity ?peValidity .
}}'''
    response = await client.get(RINF_URL, params={"query": query}, headers={"Accept": "application/sparql-results+json"})
    response.raise_for_status()
    return [{key: value["value"] for key, value in item.items()} for item in response.json()["results"]["bindings"]]


async def fetch_rinf_all(client: httpx.AsyncClient, year: int) -> dict[str, list[dict[str, str]]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for offset in range(0, 30_000, 3000):
        query = f'''PREFIX era: <http://data.europa.eu/949/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?uopid ?trackId ?platformId WHERE {{
 ?op a era:OperationalPoint ; era:uopid ?uopid ;
     era:inCountry <http://publications.europa.eu/resource/authority/country/DEU> ;
     rdfs:label ?opLabel ; era:hasPart ?track .
 FILTER(CONTAINS(STR(?opLabel), "{year}"))
 ?track era:trackId ?trackId ; era:hasPart ?pe .
 ?pe era:platformId ?platformId ; era:validity ?peValidity .
}} ORDER BY ?uopid LIMIT 3000 OFFSET {offset}'''
        response = await client.get(RINF_URL, params={"query": query}, headers={"Accept": "application/sparql-results+json"})
        response.raise_for_status()
        bindings = response.json()["results"]["bindings"]
        for item in bindings:
            row = {key: value["value"] for key, value in item.items()}
            grouped[row["uopid"]].append(row)
        if len(bindings) < 3000:
            break
    return grouped


async def fetch_osm_identity(client: httpx.AsyncClient, rl100: str) -> str | None:
    query = f'[out:json][timeout:25];node["railway:ref"="{rl100}"];out tags;'
    pause = 2.0
    for attempt in range(4):
        response = await client.post(OVERPASS_URL, data={"data": query})
        if response.status_code != 429:
            response.raise_for_status()
            elements = response.json().get("elements", [])
            exact = [item for item in elements if item.get("tags", {}).get("railway:ref") == rl100]
            return next((item.get("tags", {}).get("uic_ref") for item in exact if item.get("tags", {}).get("uic_ref")), None)
        if attempt < 3:
            await asyncio.sleep(pause)
            pause *= 2
    return None


async def fetch_osm_identities_bulk(client: httpx.AsyncClient) -> dict[str, str]:
    """Load Germany in small non-overlapping boxes to respect public Overpass slots."""
    latitudes = (47.0, 49.25, 51.5, 53.75, 56.0)
    longitudes = (5.0, 7.75, 10.5, 13.25, 16.0)
    identities: dict[str, str] = {}
    for south, north in zip(latitudes, latitudes[1:]):
        for west, east in zip(longitudes, longitudes[1:]):
            query = f'[out:json][timeout:40];node["railway:ref"]({south},{west},{north},{east});out tags;'
            pause = 5.0
            for attempt in range(5):
                response = await client.post(OVERPASS_URL, data={"data": query})
                if response.status_code == 429:
                    if attempt == 4:
                        response.raise_for_status()
                    await asyncio.sleep(pause)
                    pause = min(pause * 2, 40)
                    continue
                response.raise_for_status()
                for item in response.json().get("elements", []):
                    tags = item.get("tags", {})
                    if tags.get("railway:ref") and tags.get("uic_ref"):
                        identities[tags["railway:ref"].upper()] = tags["uic_ref"]
                break
            await asyncio.sleep(5)
    return identities


def merge_platforms(station: dict[str, str], isr_rows: list[dict[str, str]], rinf_rows: list[dict[str, str]], eva: str | None) -> list[dict[str, Any]]:
    by_platform: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rinf_rows:
        by_platform[row.get("platformId", "")].append(row)
    output = []
    rl100 = station["BST_RL100"].strip().upper()
    uopid = rinf_uopid(rl100)
    for source in isr_rows:
        operating = source.get("GLEISNUMMER__BETRIEB", "").strip()
        traffic = source.get("GLEISNUMMER__VERKEHR", "").strip()
        matches = by_platform.get(operating) or by_platform.get(traffic) or [
            item for platform, items in by_platform.items() if platform.split("-", 1)[0] in {operating, traffic} for item in items
        ]
        method = "nur ISR"
        note = "Station oder Bahnsteig nicht in RINF geführt"
        if matches:
            method = "ISR+RINF eindeutig" if len(matches) == 1 else "ISR+RINF mehrdeutig"
            note = None if len(matches) == 1 else f"{len(matches)} richtungsspezifische RINF-Kanten"
        match = matches[0] if matches else None
        row = {
                "eva_nummer": eva, "ds100_rl100": rl100,
                "bahnhofsname": station.get("BST_STELLE_NAME", ""), "streckennummer": station.get("STRNR") or None,
                # OSM is matched later as a supplementary geometry source. Do
                # not mislabel the ISR traffic-track number as an OSM ref.
                "osm_bahnsteig_ref": None, "isr_gleisnummer_betrieb": operating,
                "isr_gleisnummer_verkehr": traffic or None,
                "isr_systemhoehe_cm": _number(source.get("SYSTEMHÖHE_IN_CM")),
                "isr_bahnsteignutzlaenge_m": _number(source.get("MAX__BAHNSTEIGNUTZLAENGEN_IN_M")),
                "rinf_uopid": uopid if match else None,
                "rinf_platform_id": " | ".join(sorted({item.get("platformId", "") for item in matches})) if matches else None,
                "rinf_track_id": " | ".join(sorted({item.get("trackId", "") for item in matches})) if matches else None,
                "match_methode": method, "anmerkungen": note,
        }
        row["source_hash"] = _hash(row)
        output.append(row)
    return output


def upsert_rows(rows: list[dict[str, Any]]) -> dict[str, int]:
    changed = unchanged = 0
    now = datetime.now(UTC)
    engine = get_engine()
    with engine.begin() as connection:
        for row in rows:
            existing = connection.execute(text("SELECT source_hash FROM bahnsteige WHERE ds100_rl100=:ds100_rl100 AND isr_gleisnummer_betrieb=:isr_gleisnummer_betrieb"), row).scalar()
            if existing == row["source_hash"]:
                connection.execute(text("UPDATE bahnsteige SET last_checked_at=:now WHERE ds100_rl100=:ds100_rl100 AND isr_gleisnummer_betrieb=:isr_gleisnummer_betrieb"), {**row, "now": now})
                unchanged += 1
                continue
            columns = ", ".join((*BUSINESS_COLUMNS, "source_hash", "last_checked_at", "updated_at"))
            values = ", ".join(f":{column}" for column in (*BUSINESS_COLUMNS, "source_hash")) + ", :now, :now"
            updates = ", ".join(f"{column}=EXCLUDED.{column}" for column in (*BUSINESS_COLUMNS, "source_hash")) + ", last_checked_at=:now, updated_at=:now"
            connection.execute(text(f"INSERT INTO bahnsteige ({columns}) VALUES ({values}) ON CONFLICT (ds100_rl100, isr_gleisnummer_betrieb) DO UPDATE SET {updates}"), {**row, "now": now})
            changed += 1
    return {"changed": changed, "unchanged": unchanged}


def cache_operational_points(stations: list[dict[str, str]]) -> None:
    statement = text("""
        INSERT INTO betriebsstelle
          (stel_id, ds100_rl100, bahnhofsname, streckennummer, personenverkehr, last_checked_at)
        VALUES (:stel_id, :rl100, :name, :line, true, now())
        ON CONFLICT (stel_id) DO UPDATE SET
          ds100_rl100=EXCLUDED.ds100_rl100, bahnhofsname=EXCLUDED.bahnhofsname,
          streckennummer=EXCLUDED.streckennummer, personenverkehr=true,
          last_checked_at=now()
    """)
    with get_engine().begin() as connection:
        connection.execute(statement, [
            {"stel_id": row["STEL_ID"], "rl100": row["BST_RL100"].strip().upper(),
             "name": row.get("BST_STELLE_NAME", ""), "line": row.get("STRNR") or None}
            for row in stations if row.get("STEL_ID") and row.get("BST_RL100")
        ])


def cached_operational_point(rl100: str | None, stel_id: str | None) -> dict[str, str] | None:
    where = "ds100_rl100=:value" if rl100 else "stel_id=:value"
    value = rl100.strip().upper() if rl100 else stel_id
    with get_engine().connect() as connection:
        row = connection.execute(text(
            f"SELECT stel_id, ds100_rl100, bahnhofsname, streckennummer FROM betriebsstelle WHERE {where}"
        ), {"value": value}).mappings().first()
    if not row:
        return None
    return {"STEL_ID": row["stel_id"], "BST_RL100": row["ds100_rl100"],
            "BST_STELLE_NAME": row["bahnhofsname"], "STRNR": row["streckennummer"] or ""}


async def fetch_station_data(rl100: str | None = None, stel_id: str | None = None) -> dict[str, Any]:
    if not rl100 and not stel_id:
        raise ValueError("rl100 or stel_id is required")
    year = datetime.now(UTC).year
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        station = cached_operational_point(rl100, stel_id)
        if not station:
            stations = await fetch_operational_points(client, year)
            cache_operational_points(stations)
            station = next((row for row in stations if (rl100 and row.get("BST_RL100", "").upper() == rl100.upper()) or (stel_id and row.get("STEL_ID") == stel_id)), None)
        if not station:
            raise LookupError("Personenbahnhof nicht im ISR gefunden")
        station_rl100 = station["BST_RL100"].strip().upper()
        isr, rinf, eva = await asyncio.gather(
            fetch_isr_platforms(client, station["STEL_ID"]),
            fetch_rinf_station(client, rinf_uopid(station_rl100), year),
            fetch_osm_identity(client, station_rl100),
        )
    rows = merge_platforms(station, isr, rinf, eva)
    result = upsert_rows(rows)
    return {"station": station_rl100, "rows": rows, **result, "last_checked_at": datetime.now(UTC)}


async def sync_all_stations(concurrency: int = 75) -> dict[str, Any]:
    year = datetime.now(UTC).year
    errors: list[dict[str, str]] = []
    totals = {"stations": 0, "rows": 0, "changed": 0, "unchanged": 0}
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        stations = await fetch_operational_points(client, year)
        cache_operational_points(stations)
        rinf_by_uopid, osm_by_rl100 = await asyncio.gather(
            fetch_rinf_all(client, year), fetch_osm_identities_bulk(client)
        )
        semaphore = asyncio.Semaphore(max(1, min(concurrency, 100)))
        async def process(station: dict[str, str]):
            rl100 = station.get("BST_RL100", "").strip().upper()
            try:
                async with semaphore:
                    isr = await fetch_isr_platforms(client, station["STEL_ID"])
                    rows = merge_platforms(
                        station, isr, rinf_by_uopid.get(rinf_uopid(rl100), []),
                        osm_by_rl100.get(rl100),
                    )
                    return rows, upsert_rows(rows)
            except Exception as error:
                errors.append({"rl100": rl100, "error": type(error).__name__})
                return [], {"changed": 0, "unchanged": 0}
        results = await asyncio.gather(*(process(station) for station in stations))
    for rows, write_result in results:
        totals["stations"] += 1
        totals["rows"] += len(rows)
        totals["changed"] += write_result["changed"]
        totals["unchanged"] += write_result["unchanged"]
    return {**totals, "errors": errors, "completed_at": datetime.now(UTC)}


# Public aliases requested by embedding clients.
fetchStationData = fetch_station_data
syncAllStations = sync_all_stations
