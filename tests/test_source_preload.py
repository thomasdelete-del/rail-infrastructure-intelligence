import asyncio
import httpx
from app.services import source_preload


def test_netex_preload_retains_generic_station_infrastructure(monkeypatch):
    saved = []
    monkeypatch.setattr(source_preload, 'save_snapshot', lambda *args: saved.append(args))
    xml = b'''<PublicationDelivery><StopPlace id="dhid:test:1"><Name>Achern</Name>
      <PrivateCode>6</PrivateCode></StopPlace><StopPlace id="dhid:test:2">
      <Name>Teststation</Name><PrivateCode>7</PrivateCode></StopPlace></PublicationDelivery>'''
    async def scenario():
        transport = httpx.MockTransport(lambda request: httpx.Response(200, content=xml))
        async with httpx.AsyncClient(transport=transport) as client:
            await source_preload.preload_netex(client)
    asyncio.run(scenario())
    assert [row[1] for row in saved] == [6, 7]
    assert all(row[2]['infrastructure'] is not None for row in saved)
