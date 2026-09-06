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
    rows = []
    for binding in data.get("results", {}).get("bindings", []):
        def value(key: str) -> str | None:
            item = binding.get(key)
            return item.get("value") if isinstance(item, dict) else None
        try:
            length = float(value("length") or "")
        except ValueError:
            continue
        rows.append({"platform_id": (value("platformId") or "").strip(), "usable_length_m": length, "uopid": value("uopid"), "source_url": value("platform") or RINF_ENDPOINT})
    return rows


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
SELECT DISTINCT ?opLabel ?uopid ?platform ?platformId ?length WHERE {{
  ?op a era:OperationalPoint ; rdfs:label ?opLabel ; era:uopid ?uopid ; era:track ?track .
  ?track era:platformEdge ?platform .
  ?platform era:platformId ?platformId ; era:lengthOfPlatform ?length .
  OPTIONAL {{ ?platform era:validityStartDate ?validFrom }}
  OPTIONAL {{ ?platform era:validityEndDate ?validTo }}
  FILTER(STRENDS(STR(?uopid), "{safe_ril}"))
  FILTER(!BOUND(?validFrom) || ?validFrom <= "{today}"^^<http://www.w3.org/2001/XMLSchema#date>)
  FILTER(!BOUND(?validTo) || ?validTo >= "{today}"^^<http://www.w3.org/2001/XMLSchema#date>)
}} ORDER BY ?platformId'''
    async with httpx.AsyncClient(timeout=90, follow_redirects=True, headers={"User-Agent": "rail-infrastructure-intelligence/1.4"}) as client:
        index = await _equipment_index(client)
        page_url = index.get(_normalize(name))
        db_request = client.get(page_url) if page_url else None
        rinf_request = client.get(RINF_ENDPOINT, params={"query": query}, headers={"Accept": "application/sparql-results+json"})
        if db_request:
            db_response, rinf_response = await asyncio.gather(db_request, rinf_request)
            db_response.raise_for_status()
            db_platforms = parse_db_platform_table(db_response.text)
        else:
            rinf_response = await rinf_request
            db_platforms = []
        rinf_response.raise_for_status()
    rinf_platforms = parse_rinf_lengths(rinf_response.json())
    by_track = {row["platform_id"]: row for row in rinf_platforms}
    if len(db_platforms) == len(rinf_platforms) == 1:
        by_track[db_platforms[0]["track"]] = rinf_platforms[0]
    platforms = []
    for row in db_platforms:
        usable = by_track.get(row["track"])
        platforms.append({**row, "usable_length_m": usable["usable_length_m"] if usable else None, "rinf_platform_id": usable["platform_id"] if usable else None})
    known_tracks = {row["track"] for row in db_platforms}
    for row in rinf_platforms:
        if row["platform_id"] not in known_tracks and not (len(db_platforms) == len(rinf_platforms) == 1):
            platforms.append({"track": row["platform_id"], "platform_height_mm": None, "net_construction_length_m": None, "usable_length_m": row["usable_length_m"], "rinf_platform_id": row["platform_id"]})
    return {
        "station": name,
        "ril": safe_ril,
        "platforms": platforms,
        "sources": {"db_infrago": page_url, "era_rinf": RINF_ENDPOINT},
        "status": {"db_infrago": "active" if db_platforms else "not_found", "era_rinf": "active" if rinf_platforms else "not_found"},
    }
