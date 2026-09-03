import httpx

from app.collectors.base import Collector, CollectedObservation


class DBInfraGOStationCollector(Collector):
    """Collector for public DB InfraGO station information.

    Parsing is intentionally conservative: a source change must not silently
    create incorrect infrastructure observations. Source-specific parsers are
    added behind fixtures/tests as the project grows.
    """

    name = "db_infrago_station"

    def __init__(self, station_url: str):
        self.station_url = station_url

    async def fetch(self) -> str:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(self.station_url)
            response.raise_for_status()
            return response.text

    async def collect(self, station: str) -> list[CollectedObservation]:
        await self.fetch()
        # Do not guess values from unstable HTML. A tested parser will convert
        # the fetched source into observations. Until then, seed data remains
        # the explicit reference dataset.
        return []
