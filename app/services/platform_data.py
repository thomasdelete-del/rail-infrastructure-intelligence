from __future__ import annotations

import asyncio
from datetime import date
from html import unescape
import re
from time import monotonic
from typing import Any
from urllib.parse import urljoin

import httpx

from app.collectors.rinf import RINF_ENDPOINT

DB_EQUIPMENT_INDEX = "https://www.dbinfrago.com/web/bahnhoefe/leistungen/stationsnutzung/stationshalt/stationsausstattung"
_INDEX_CACHE: tuple[float, dict[str, str]] | None = None
_INDEX_LOCK = asyncio.Lock()
_PLATFORM_SOURCE_CACHE: dict[str, dict[str, Any]] = {}
# Station-scoped crosswalks verified against DB operational documentation/user review.
# RINF platform IDs are not public passenger track numbers.
RINF_PLATFORM_CROSSWALKS: dict[str, dict[str, str]] = {
    "FFG": {
        "1": "1",
        "1a": "1a",
        "2": "2",
        "4": "4",
        "5": "5",
        "7": "7",
        "8": "8",
        "10": "10",
        "11": "11",
        "12": "12",
    },
    "FBB": {"293": "1"},
    "FLIH": {"962": "1"},
}


def _normalize(value: str) -> str:
    return " ".join(value.casefold().replace("bahnhof", " ").split())


def parse_equipment_index(document: str) -> dict[str, str]:
    links: dict[str, str] = {}
    pattern = re.compile(r'href="(?P<href>[^"#]*?/stationsausstattung/[^"?]+)(?:\?[^\"]*)?"(?:(?!</a>).)*?<h3[^>]*>\s*(?P<name>[^<]+)', re.I | re.S)
    for match in pattern.finditer(document):
        name = unescape(match.group("name")).strip().rstrip(".")
        if name:
            links[_normalize(name)] = urljoin(DB_EQUIPMENT_INDEX, unescape(match.group("href")))
    return links


def parse_db_platform_table(document: str) -> list[dict[str, Any]]:
    marker = document.find("Gleisnummer |")
    if marker < 0:
        return []
    end = document.find("</tbody>", marker)
    fragment = document[marker:end if end >= 0 else marker + 12000]
    fragment = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.I)
    fragment = unescape(re.sub(r"<[^>]+>", "", fragment))
    rows = []
    row_pattern = re.compile(r"^\s*([^|\n]+?)\s*\|\s*([\d,.]+)\s*cm\s*\|\s*([\d,.]+)\s*m\s*\|", re.M)
    for match in row_pattern.finditer(fragment):
        rows.append({
            "track": match.group(1).strip(),
            "platform_height_mm": round(float(match.group(2).replace(",", ".")) * 10),
            "net_construction_length_m": float(match.group(3).replace(",", ".")),
        })
    return rows


def parse_rinf_lengths(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows_by_platform: dict[tuple[str, float, str | None, str], dict[str, Any]] = {}
    for binding in data.get("results", {}).get("bindings", []):
        def value(key: str) -> str | None:
            item = binding.get(key)
            return item.get("value") if isinstance(item, dict) else None
        try:
            length = float(value("length") or "")
        except ValueError:
            continue
        platform_id = (value("platformId") or "").strip()
        if not platform_id:
            continue
        source_url = value("platform") or RINF_ENDPOINT
        key = (platform_id, length, value("uopid"), source_url)
        row = rows_by_platform.setdefault(key, {
            "platform_id": platform_id,
            "track_id": value("trackId"),
            "directional_track_ids": [],
            "line_number": value("lineId") or value("lineNationalId"),
            "usable_length_m": length,
            "uopid": value("uopid"),
            "source_url": source_url,
        })
        track_id = value("trackId")
        if track_id and track_id not in row["directional_track_ids"]:
            row["directional_track_ids"].append(track_id)
    return list(rows_by_platform.values())


def map_rinf_platforms(db_platforms: list[dict[str, Any]], rinf_platforms: list[dict[str, Any]], ril: str) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Map RINF asset IDs to DB passenger track numbers with auditable methods."""
    mapped: dict[str, dict[str, Any]] = {}
    used: set[str] = set()
    rinf_by_id = {row["platform_id"]: row for row in rinf_platforms}
    for db in db_platforms:
        if db["track"] in rinf_by_id:
            mapped[db["track"]] = {**rinf_by_id[db["track"]], "mapping_method": "exact_platform_id", "mapping_confidence": "confirmed", "mapping_score": 100, "mapping_evidence": ["exact_platform_id"]}
            used.add(db["track"])
    for rinf_id, db_track in RINF_PLATFORM_CROSSWALKS.get(ril, {}).items():
        if rinf_id in rinf_by_id and any(row["track"] == db_track for row in db_platforms):
            mapped[db_track] = {**rinf_by_id[rinf_id], "mapping_method": "station_crosswalk", "mapping_confidence": "confirmed", "mapping_score": 100, "mapping_evidence": [f"station_crosswalk:{ril}:{rinf_id}->{db_track}"]}
            used.add(rinf_id)

    # rinf-plus duplicates running tracks per direction. A track identifier is
    # usable only when it points to exactly one remaining platform edge.
    for db in [row for row in db_platforms if row["track"] not in mapped]:
        candidates = []
        for row in rinf_platforms:
            if row["platform_id"] in used:
                continue
            track_ids = row.get("directional_track_ids") or [row.get("track_id")]
            normalized_tokens = {
                token
                for track_id in track_ids
                if track_id
                for token in re.split(r"[^0-9A-Za-z]+", str(track_id))
                if token
            }
            if db["track"].casefold() in {token.casefold() for token in normalized_tokens}:
                candidates.append(row)
        if len(candidates) == 1:
            row = candidates[0]
            mapped[db["track"]] = {
                **row,
                "mapping_method": "exact_rinf_track_id",
                "mapping_confidence": "derived",
                "mapping_score": 90,
                "mapping_evidence": [f"rinf_track_id_contains_db_track:{db['track']}"],
            }
            used.add(row["platform_id"])

    # A national line number is supporting infrastructure evidence, not a
    # platform number. It is accepted only for a unique one-to-one remainder.
    for db in [row for row in db_platforms if row["track"] not in mapped and row.get("line_number")]:
        candidates = [
            row for row in rinf_platforms
            if row["platform_id"] not in used
            and str(row.get("line_number") or "").casefold() == str(db["line_number"]).casefold()
        ]
        if len(candidates) == 1:
            row = candidates[0]
            mapped[db["track"]] = {
                **row,
                "mapping_method": "unique_line_number",
                "mapping_confidence": "derived",
                "mapping_score": 80,
                "mapping_evidence": [f"unique_national_line:{db['line_number']}"],
            }
            used.add(row["platform_id"])
    remaining_db = [row for row in db_platforms if row["track"] not in mapped]
    remaining_rinf = [row for row in rinf_platforms if row["platform_id"] not in used]
    if len(remaining_db) == len(remaining_rinf) == 1:
        row = remaining_rinf[0]
        mapped[remaining_db[0]["track"]] = {**row, "mapping_method": "bijective_remainder", "mapping_confidence": "derived", "mapping_score": 80, "mapping_evidence": ["all_other_platform_edges_uniquely_assigned"]}
        used.add(row["platform_id"])
    return mapped, used


async def _equipment_index(client: httpx.AsyncClient) -> dict[str, str]:
    global _INDEX_CACHE
    async with _INDEX_LOCK:
        if _INDEX_CACHE is not None and monotonic() - _INDEX_CACHE[0] < 86400:
            return _INDEX_CACHE[1]
        response = await client.get(DB_EQUIPMENT_INDEX)
        response.raise_for_status()
        _INDEX_CACHE = (monotonic(), parse_equipment_index(response.text))
        return _INDEX_CACHE[1]


async def load_platform_data(name: str, ril: str) -> dict[str, Any]:
    """Combine DB platform dimensions with track-usable lengths from ERA RINF."""
    safe_ril = re.sub(r"[^A-Z0-9_]", "", ril.upper())
    if not safe_ril:
        raise ValueError("A valid RIL100 identifier is required")
    today = date.today().isoformat()
    query = f'''PREFIX era: <http://data.europa.eu/949/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?opLabel ?uopid ?trackId ?lineId ?platform ?platformId ?length WHERE {{
  ?op a era:OperationalPoint ; rdfs:label ?opLabel ; era:uopid ?uopid ; era:track ?track .
  ?track era:trackId ?trackId ; era:platformEdge ?platform .
  ?platform era:platformId ?platformId ; era:lengthOfPlatform ?length .
  OPTIONAL {{ ?track era:lineNationalId ?line . ?line era:lineId ?lineId }}
  OPTIONAL {{ ?platform era:validityStartDate ?validFrom }}
  OPTIONAL {{ ?platform era:validityEndDate ?validTo }}
  FILTER(STRENDS(STR(?uopid), "{safe_ril}"))
  FILTER(!BOUND(?validFrom) || ?validFrom <= "{today}"^^<http://www.w3.org/2001/XMLSchema#date>)
  FILTER(!BOUND(?validTo) || ?validTo >= "{today}"^^<http://www.w3.org/2001/XMLSchema#date>)
}} ORDER BY ?platformId'''
    page_url: str | None = None
    db_platforms: list[dict[str, Any]] = []
    rinf_platforms: list[dict[str, Any]] = []
    db_failed = False
    rinf_failed = False
    db_cached = False
    rinf_cached = False
    async with httpx.AsyncClient(timeout=90, follow_redirects=True, headers={"User-Agent": "rail-infrastructure-intelligence/1.4"}) as client:
        try:
            index = await _equipment_index(client)
            normalized_name = _normalize(name)
            page_url = index.get(normalized_name)
            if not page_url:
                contained = [url for indexed_name, url in index.items()
                             if normalized_name in indexed_name.split() or indexed_name.endswith(normalized_name)]
                if len(set(contained)) == 1:
                    page_url = contained[0]
            if page_url:
                db_response = await client.get(page_url)
                db_response.raise_for_status()
                db_platforms = parse_db_platform_table(db_response.text)
                if db_platforms:
                    _PLATFORM_SOURCE_CACHE.setdefault(safe_ril, {})["db"] = db_platforms
        except httpx.HTTPError:
            db_failed = True

        try:
            rinf_response = await client.get(RINF_ENDPOINT, params={"query": query}, headers={"Accept": "application/sparql-results+json"})
            rinf_response.raise_for_status()
            rinf_platforms = parse_rinf_lengths(rinf_response.json())
            if rinf_platforms:
                _PLATFORM_SOURCE_CACHE.setdefault(safe_ril, {})["rinf"] = rinf_platforms
        except httpx.HTTPError:
            rinf_failed = True

    cached = _PLATFORM_SOURCE_CACHE.get(safe_ril, {})
    if db_failed and cached.get("db"):
        db_platforms = cached["db"]
        db_cached = True
    if rinf_failed and cached.get("rinf"):
        rinf_platforms = cached["rinf"]
        rinf_cached = True

    if db_failed and rinf_failed:
        raise httpx.HTTPError("DB InfraGO and ERA RINF are temporarily unavailable")
    by_track, used_rinf_ids = map_rinf_platforms(db_platforms, rinf_platforms, safe_ril)
    platforms = []
    for row in db_platforms:
        usable = by_track.get(row["track"])
        platforms.append({**row, "usable_length_m": usable["usable_length_m"] if usable else None, "rinf_platform_id": usable["platform_id"] if usable else None, "rinf_track_id": usable.get("track_id") if usable else None, "rinf_line_number": usable.get("line_number") if usable else None, "mapping_method": usable.get("mapping_method") if usable else None, "mapping_confidence": usable.get("mapping_confidence") if usable else None, "mapping_score": usable.get("mapping_score") if usable else None, "mapping_evidence": usable.get("mapping_evidence") if usable else []})
    for row in rinf_platforms:
        if row["platform_id"] not in used_rinf_ids:
            platforms.append({"track": row["platform_id"], "platform_height_mm": None, "net_construction_length_m": None, "usable_length_m": row["usable_length_m"], "rinf_platform_id": row["platform_id"], "rinf_track_id": row.get("track_id"), "mapping_method": "unmapped", "mapping_confidence": "unresolved"})
    return {
        "station": name,
        "ril": safe_ril,
        "platforms": platforms,
        "sources": {"db_infrago": page_url, "era_rinf": RINF_ENDPOINT},
        "status": {
            "db_infrago": "cached" if db_cached else "unavailable" if db_failed else "active" if db_platforms else "not_found",
            "era_rinf": "cached" if rinf_cached else "unavailable" if rinf_failed else "active" if rinf_platforms else "not_found",
        },
    }
