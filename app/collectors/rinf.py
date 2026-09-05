from datetime import date
from typing import Any

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.collectors.osm import ROOT_OBJECT_KEY
from app.identity import FRIEDBERG_HESS, is_friedberg_hess


RINF_ENDPOINT = "https://graph.data.era.europa.eu/repositories/rinf"
FRIEDBERG_UOPID = "DE00FFG"
KNOWN_PLATFORM_IDS = {"1", "1a", "2", "4", "5", "7", "8", "10", "11", "12"}


def _binding(row: dict[str, Any], key: str) -> str | None:
    value = row.get(key)
    return str(value.get("value")) if isinstance(value, dict) and value.get("value") is not None else None


def parse_rinf_platforms(data: dict[str, Any], on_date: date | None = None) -> list[CollectedObservation]:
    requested_date = on_date or date.today()
    rows = data.get("results", {}).get("bindings", [])
    observations: list[CollectedObservation] = []
    seen: set[tuple[str, float, str | None, str | None]] = set()

    for row in rows:
        label, uopid = _binding(row, "opLabel"), _binding(row, "uopid")
        if uopid != FRIEDBERG_UOPID or not label or not is_friedberg_hess(label, FRIEDBERG_HESS.station_number):
            continue
        platform_id = (_binding(row, "platformId") or "").strip()
        try:
            length = float(_binding(row, "length") or "")
        except ValueError:
            continue
        valid_from, valid_to = _binding(row, "validFrom"), _binding(row, "validTo")
        if valid_from and requested_date.isoformat() < valid_from:
            continue
        if valid_to and requested_date.isoformat() > valid_to:
            continue
        identity = (platform_id, length, valid_from, valid_to)
        if not platform_id or identity in seen:
            continue
        seen.add(identity)

        mapped = platform_id in KNOWN_PLATFORM_IDS
        object_key = f"FRI-PE-{platform_id.upper()}" if mapped else f"FRI-RINF-PE-{platform_id.upper()}"
        canonical_uri = _binding(row, "platform") or _binding(row, "canonicalUri") or RINF_ENDPOINT
        metadata = {
            "uopid": uopid,
            "operational_point": label,
            "platform_id": platform_id,
            "valid_from": valid_from,
            "valid_to": valid_to,
            "rinf_parameter": "1.2.1.0.6.4",
            "rinf_property": "http://data.europa.eu/949/lengthOfPlatform",
            "rinf_platform_uri": canonical_uri,
            "identity_status": "matched_platform_id" if mapped else "unmatched_platform_id",
            "parent_object_key": ROOT_OBJECT_KEY,
        }
        if not mapped:
            observations.append(CollectedObservation(
                object_key=object_key, object_type="platform_edge", attribute="name", value=platform_id,
                unit=None, source_key="era-rinf", source_url=canonical_uri,
                source_publisher="European Union Agency for Railways", source_type="primary_register",
                source_date=valid_from, quality_class="A",
                note="RINF platform ID is not automatically mapped to an OpenStation platform edge.", metadata=metadata,
            ))
        observations.append(CollectedObservation(
            object_key=object_key, object_type="platform_edge", attribute="usable_length", value=length,
            unit="m", source_key="era-rinf", source_url=canonical_uri,
            source_publisher="European Union Agency for Railways", source_type="primary_register",
            source_date=valid_from, quality_class="A",
            note="Usable length of platform (RINF parameter 1.2.1.0.6.4).", metadata=metadata,
        ))
    return observations


class RINFCollector(Collector):
    name = "era_rinf"
    endpoint = RINF_ENDPOINT

    async def collect(self, station: str) -> list[CollectedObservation]:
        if not is_friedberg_hess(station, FRIEDBERG_HESS.station_number):
            return []
        today = date.today()
        query = f'''PREFIX era: <http://data.europa.eu/949/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?opLabel ?uopid ?platform ?canonicalUri ?platformId ?length ?validFrom ?validTo WHERE {{
  ?op a era:OperationalPoint ; rdfs:label ?opLabel ; era:uopid ?uopid ; era:track ?track .
  ?track era:platformEdge ?platform .
  ?platform era:platformId ?platformId ; era:lengthOfPlatform ?length .
  OPTIONAL {{ ?platform era:canonicalURI ?canonicalUri }}
  OPTIONAL {{ ?platform era:validityStartDate ?validFrom }}
  OPTIONAL {{ ?platform era:validityEndDate ?validTo }}
  FILTER(?uopid = "{FRIEDBERG_UOPID}" && STR(?opLabel) = "Friedberg (Hess)")
  FILTER(!BOUND(?validFrom) || ?validFrom <= "{today.isoformat()}"^^<http://www.w3.org/2001/XMLSchema#date>)
  FILTER(!BOUND(?validTo) || ?validTo >= "{today.isoformat()}"^^<http://www.w3.org/2001/XMLSchema#date>)
}} ORDER BY ?platformId'''
        async with httpx.AsyncClient(timeout=60, headers={"Accept": "application/sparql-results+json"}) as client:
            response = await client.get(self.endpoint, params={"query": query})
            response.raise_for_status()
            return parse_rinf_platforms(response.json(), today)
