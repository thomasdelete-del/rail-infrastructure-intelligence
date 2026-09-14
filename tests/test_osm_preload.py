import asyncio
import httpx
import pytest
from app.services import osm_preload

def fetch(payload):
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request:httpx.Response(200,json=payload))) as client:
            return await osm_preload.fetch_geometry(client,'https://example.test',50,8)
    return asyncio.run(scenario())

def test_geometry_is_retained_and_bus_platforms_filtered():
    rail={'type':'way','id':1,'tags':{'railway':'platform_edge'},'geometry':[{'lat':50,'lon':8},{'lat':50.001,'lon':8}]}
    assert fetch({'elements':[rail,{'tags':{'highway':'bus_stop'}}]}) == [rail]

def test_successful_empty_delivery():
    assert fetch({'elements':[]}) == []

def test_incomplete_delivery_is_not_a_success():
    with pytest.raises(ValueError): fetch({'elements':[],'remark':'timeout'})

def test_response_memory_limit(monkeypatch):
    monkeypatch.setattr(osm_preload,'MAX_RESPONSE_BYTES',4)
    with pytest.raises(ValueError,match='memory safety'): fetch({'elements':[]})
