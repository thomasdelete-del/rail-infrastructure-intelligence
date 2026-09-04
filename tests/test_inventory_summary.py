from app.repository import summarize_infrastructure_inventory


def observation(attribute, value, source="openstation", unit=None):
    return {"attribute": attribute, "value": value, "unit": unit, "source_key": source,
            "observed_at": "2026-09-04", "provenance": {}}


def test_summary_reports_current_conflicts_counts_and_gaps():
    inventory = {
        "station": "Friedberg (Hess)", "object_count": 4,
        "objects": [
            {"object_key": "station", "object_type": "stop_place", "depth": 0,
             "observations": [observation("name", "Friedberg (Hess)")]},
            {"object_key": "edge-1", "object_type": "platform_edge", "depth": 2,
             "observations": [observation("name", "1"), observation("height", 760, "source-a", "mm"),
                              observation("height", 550, "source-b", "mm")]},
            {"object_key": "stairs", "object_type": "equipment", "depth": 1,
             "observations": [observation("equipment_type", "StaircaseEquipment")]},
            {"object_key": "entrance", "object_type": "entrance", "depth": 1,
             "observations": [observation("name", "Vorplatz")]},
        ],
    }
    result = summarize_infrastructure_inventory(inventory)
    assert result["object_types"] == {"entrance": 1, "equipment": 1, "platform_edge": 1, "stop_place": 1}
    assert result["platform_edges"] == ["1"]
    assert result["equipment_types"] == {"StaircaseEquipment": 1}
    assert result["conflict_count"] == 1
    assert result["conflicts"][0]["attribute"] == "height"
    assert {gap["code"] for gap in result["data_gaps"]} == {
        "station_coordinates_missing", "entrance_coordinates_missing", "lift_data_missing",
    }


def test_summary_uses_latest_observation_per_source():
    inventory = {
        "station": "Friedberg (Hess)", "object_count": 1,
        "objects": [{"object_key": "station", "object_type": "stop_place", "depth": 0,
                     "observations": [observation("lighting", "poor"), observation("lighting", "wellLit")]}],
    }
    result = summarize_infrastructure_inventory(inventory)
    assert result["conflict_count"] == 0
