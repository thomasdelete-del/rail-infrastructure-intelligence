import asyncio
import pytest

from app.services import station_identity
from app.services.station_identity import normalize_stada_station, prioritize_station_identity, select_station_identity


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


def test_netex_identity_has_priority_and_osm_cannot_overwrite_it():
    result = prioritize_station_identity(
        {"name": "Dorheim", "station_number": 1273, "eva": "8001520", "ril": "FDHM", "dhid": "de:06440:6402"},
        {"name": "Dorheim Europa", "ril": "WRONG"},
        {"matched_name": "Dorheim OSM", "station_number": "9999", "osm_type": "node", "osm_id": 1},
    )
    assert result["matched_name"] == "Dorheim"
    assert result["station_number"] == 1273
    assert result["ril"] == "FDHM"
    assert result["identity_source"] == "netex"
    assert result["osm_id"] == 1


def test_stada_identity_has_priority_over_netex():
    result = prioritize_station_identity(
        {"name": "Friedberg NeTEx", "station_number": 1}, None, None,
        stada={"name": "Friedberg (Hess)", "station_number": 1930, "eva": "8000111"},
    )
    assert result["matched_name"] == "Friedberg (Hess)"
    assert result["station_number"] == 1930
    assert result["identity_source"] == "stada"


def test_normalizes_stada_station_for_picker():
    result = normalize_stada_station({
        "number": 1930, "name": "Friedberg (Hess)",
        "evaNumbers": [{"number": 8000111, "isMain": True, "geographicCoordinates": {"coordinates": [8.761, 50.332]}}],
        "ril100Identifiers": [{"rilIdentifier": "FFG", "isMain": True}],
    })
    assert result == {"station_number": 1930, "name": "Friedberg (Hess)", "eva": 8000111, "ril": "FFG", "longitude": 8.761, "latitude": 50.332}


def test_searches_db_netex_station_list(monkeypatch):
    xml = b'''<root><StopPlace id="dhid:de:1"><Name>Dorheim</Name><PrivateCode>1273</PrivateCode><Centroid><Location><Latitude>50.35</Latitude><Longitude>8.79</Longitude></Location></Centroid></StopPlace><StopPlace id="dhid:de:2"><Name>Berlin Hbf</Name><Centroid><Location><Latitude>52.52</Latitude><Longitude>13.36</Longitude></Location></Centroid></StopPlace></root>'''
    async def fixture(): return xml
    monkeypatch.setattr(station_identity, "_netex_xml", fixture)
    result = asyncio.run(station_identity.search_netex_stations("Dorheim"))
    assert [item["station_number"] for item in result] == [1273]


def test_stada_list_prefers_railway_snapshot_without_external_request(monkeypatch):
    stored = [{
        "station_number": 1930,
        "name": "Friedberg (Hess)",
        "eva": 8000111,
        "ril": "FFG",
        "latitude": 50.332,
        "longitude": 8.761,
        "stored_at": "2026-09-07T12:00:00Z",
    }]
    monkeypatch.setattr(station_identity, "_STADA_CACHE", None)
    monkeypatch.setattr(station_identity, "load_station_locations", lambda: stored)
    monkeypatch.delenv("DB_API_CLIENT_ID", raising=False)
    monkeypatch.delenv("DB_API_KEY", raising=False)

    result = asyncio.run(station_identity.stada_station_list())

    assert result == [{key: value for key, value in stored[0].items() if key != "stored_at"}]
