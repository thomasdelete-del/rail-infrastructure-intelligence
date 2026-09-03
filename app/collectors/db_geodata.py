import httpx

from app.collectors.base import Collector, CollectedObservation


class DBInfraGOGeodataCollector(Collector):
    """Framework for DB InfraGO public geodata datasets.

    Intended layers include operating points, railway crossings, bridges,
    tunnels and route network. Geometry import will be normalized to EPSG:4326
    while the original CRS and source feature identifier remain provenance.
    """

    name = "db_infrago_geodata"
    catalog_url = "https://data.gov.de/suche/daten/infrastrukturdaten-der-db-infrago"

    async def fetch_catalog(self) -> str:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(self.catalog_url)
            response.raise_for_status()
            return response.text

    async def collect(self, station: str) -> list[CollectedObservation]:
        await self.fetch_catalog()
        # Dataset resource discovery/import is deliberately separated from
        # catalog retrieval so changed download URLs cannot corrupt the store.
        return []
