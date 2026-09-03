from io import BytesIO
from xml.etree.ElementTree import iterparse

import httpx

from app.collectors.base import Collector, CollectedObservation
from app.identity import is_friedberg_hess


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(element, names: set[str]) -> str | None:
    for child in element.iter():
        if local_name(child.tag) in names and child.text and child.text.strip():
            return child.text.strip()
    return None


def extract_friedberg_stop_places(xml: bytes) -> list[dict]:
    """Extract only StopPlace records that can be identified as Friedberg (Hess).

    The parser is namespace-agnostic and clears processed elements to keep
    memory bounded for large NeTEx feeds. Ambiguous Friedberg records are
    rejected instead of being guessed into the twin.
    """
    matches = []
    for _, element in iterparse(BytesIO(xml), events=("end",)):
        if local_name(element.tag) != "StopPlace":
            continue
        name = child_text(element, {"Name", "ShortName"})
        if name and is_friedberg_hess(name):
            latitude = child_text(element, {"Latitude"})
            longitude = child_text(element, {"Longitude"})
            matches.append({
                "netex_id": element.attrib.get("id"),
                "name": name,
                "latitude": float(latitude) if latitude else None,
                "longitude": float(longitude) if longitude else None,
            })
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
        if not is_friedberg_hess(station):
            return []
        records = extract_friedberg_stop_places(await self.fetch_netex())
        observations = []
        for record in records:
            object_key = f"FRI-NETEX-{record['netex_id'] or 'STOPPLACE'}"
            common = dict(
                object_key=object_key,
                object_type="stop_place",
                source_key=self.source_key,
                source_url=self.netex_url,
                quality_class="A",
                metadata={"netex_id": record["netex_id"]},
            )
            observations.append(CollectedObservation(attribute="name", value=record["name"], unit=None, **common))
            if record["latitude"] is not None:
                observations.append(CollectedObservation(attribute="latitude", value=record["latitude"], unit="degree", **common))
            if record["longitude"] is not None:
                observations.append(CollectedObservation(attribute="longitude", value=record["longitude"], unit="degree", **common))
        return observations
