from app.services.osm_platforms import filter_rail_objects, platform_query


def test_platform_query_requests_edges_and_platform_areas():
    query = platform_query(50.3021834, 8.78848851)
    assert "[railway=platform]" in query
    assert "[railway=platform_edge]" in query


def test_filter_keeps_rail_platform_areas_but_rejects_bus_platforms():
    elements = [
        {"id": 1, "tags": {"railway": "platform", "ref": "1"}},
        {"id": 2, "tags": {"public_transport": "platform", "highway": "bus_stop"}},
    ]
    assert filter_rail_objects(elements) == [elements[0]]
