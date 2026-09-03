import httpx

from app.collectors.base import Collector, CollectedObservation


class OpenStationCollector(Collector):
    """DB InfraGO OpenStation NeTEx feed collector.

    The public bahnhof.de redirect allows a first implementation without
    storing DB API credentials. XML parsing and station identity resolution are
    kept as explicit next steps to prevent Friedberg (Hess) / similarly named
    stations from being mixed.
    """

    name = "openstation_netex"
    netex_url = "https://bahnhof.de/daten/netex"

    async def fetch_netex(self) -> bytes:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            response = await client.get(self.netex_url, headers={"Accept-Encoding": "gzip"})
            response.raise_for_status()
            return response.content

    async def collect(self, station: str) -> list[CollectedObservation]:
        await self.fetch_netex()
        return []
