from app.services.osm_platforms import filter_rail_objects, platform_query
import asyncio
from app.services import osm_platforms as osm


def test_memory_cache_is_bounded():
    osm._OSM_PLATFORM_CACHE.clear()
    for index in range(osm.MAX_CACHE_ENTRIES + 5):
        osm._remember_platforms((index, 0), {"elements": []})
    assert len(osm._OSM_PLATFORM_CACHE) == osm.MAX_CACHE_ENTRIES
    assert (0, 0) not in osm._OSM_PLATFORM_CACHE
    osm._OSM_PLATFORM_CACHE.clear()


def test_railway_cache_does_not_trigger_external_reload(monkeypatch):
    monkeypatch.setattr(osm, "_cached_platforms", lambda _: [{"id": 1}])
    async def forbidden(*args):
        raise AssertionError("Unexpected external reload")
    monkeypatch.setattr(osm, "_refresh_osm_platforms", forbidden)
    result = asyncio.run(osm.load_osm_platforms(50, 8, "FAS"))
    assert result["cache_used"] and not result["refresh_running"]


def test_duplicate_refreshes_share_one_task(monkeypatch):
    async def scenario():
        calls = []
        async def fetch(*args):
            calls.append(args)
            await asyncio.sleep(0)
            return {"elements": [{"id": 1}]}
        monkeypatch.setattr(osm, "_refresh_osm_platforms", fetch)
        results = await asyncio.gather(*(osm._bounded_refresh(50, 8, "FAS") for _ in range(10)))
        assert len(calls) == 1
        assert len(results) == 10
        assert not osm._REFRESH_TASKS
    asyncio.run(scenario())


def test_platform_query_requests_edges_and_platform_areas():
    query = platform_query(50.3021834, 8.78848851)
    assert "[railway=platform]" in query
    assert "[railway=platform_edge]" in query
    assert "[public_transport=platform][train=yes]" in query


def test_filter_keeps_rail_platform_areas_but_rejects_bus_platforms():
    elements = [
        {"id": 1, "tags": {"railway": "platform", "ref": "1"}},
        {"id": 2, "tags": {"public_transport": "platform", "highway": "bus_stop"}},
    ]
    assert filter_rail_objects(elements) == [elements[0]]


def test_filter_keeps_train_platform_from_public_transport_schema():
    element = {"id": 3, "tags": {"public_transport": "platform", "train": "yes"}}
    assert filter_rail_objects([element]) == [element]
