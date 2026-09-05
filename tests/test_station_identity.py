import pytest

from app.services.station_identity import select_station_identity


def station(osm_id, name, lat, lon, **tags):
    return {"type": "node", "id": osm_id, "lat": lat, "lon": lon,
            "tags": {"railway": "station", "name": name, **tags}}


def test_identity_prefers_name_and_distance_and_returns_db_keys():
    result = select_station_identity([
        station(1, "Friedberg (Bayern)", 50.333, 8.761),
        station(2, "Friedberg (Hess)", 50.3327, 8.7613, **{"ref:ibnr": "8000111", "railway:ref": "FFG", "ref:station": "1930"}),
    ], "Friedberg (Hess)", 50.33269, 8.76126)
    assert result["osm_id"] == 2
    assert (result["eva"], result["ril"], result["station_number"]) == ("8000111", "FFG", "1930")
    assert result["identity_status"] == "identified"


def test_identity_rejects_station_outside_radius():
    with pytest.raises(LookupError):
        select_station_identity([station(1, "Elsewhere", 53.0, 10.0)], "Dorheim", 50.4, 8.8)
