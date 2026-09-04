from app.repository import build_infrastructure_inventory


def test_inventory_keeps_hierarchy_and_conflicting_evidence():
    rows = [
        {"object_key": "station", "object_type": "stop_place", "parent_object_key": None, "depth": 0,
         "attribute": "name", "value": "Friedberg (Hess)", "unit": None, "source_key": "openstation",
         "observed_at": "2026-09-04", "provenance": {"netex_id": "station"}},
        {"object_key": "edge", "object_type": "platform_edge", "parent_object_key": "platform", "depth": 2,
         "attribute": "height", "value": 760, "unit": "mm", "source_key": "source-a",
         "observed_at": "2026-09-04", "provenance": {}},
        {"object_key": "edge", "object_type": "platform_edge", "parent_object_key": "platform", "depth": 2,
         "attribute": "height", "value": 550, "unit": "mm", "source_key": "source-b",
         "observed_at": "2026-09-04", "provenance": {}},
    ]
    result = build_infrastructure_inventory(rows, "Friedberg (Hess)")
    assert result["object_count"] == 2
    edge = next(item for item in result["objects"] if item["object_key"] == "edge")
    assert edge["parent_object_key"] == "platform"
    assert [item["value"] for item in edge["observations"]] == [760, 550]
