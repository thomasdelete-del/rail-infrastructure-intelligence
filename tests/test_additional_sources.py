from app.collectors.fasta import parse_fasta_facilities
from app.collectors.osm import ROOT_OBJECT_KEY, parse_osm_friedberg
from app.collectors.stada import parse_stada_station


def test_osm_requires_exact_friedberg_identity():
    wrong = {"elements": [{"type": "node", "id": 1, "lat": 48.3, "lon": 10.9,
                           "tags": {"railway": "station", "ref:ibnr": "8000111", "ref:station": "1930",
                                    "railway:ref": "FFG", "name": "Friedberg (Bay)"}}]}
    assert parse_osm_friedberg(wrong) == []


def test_osm_maps_station_and_nearby_infrastructure_with_provenance():
    payload = {"elements": [
        {"type": "node", "id": 1, "lat": 50.331, "lon": 8.760,
         "tags": {"railway": "station", "ref:ibnr": "8000111", "ref:station": "1930",
                  "uic_ref": "8011379", "railway:ref": "FFG", "name": "Friedberg (Hess)"}},
        {"type": "node", "id": 2, "lat": 50.332, "lon": 8.761,
         "tags": {"highway": "elevator", "wheelchair": "yes"}},
        {"type": "way", "id": 3, "center": {"lat": 50.333, "lon": 8.762},
         "geometry": [{"lat": 50.332, "lon": 8.761}, {"lat": 50.333, "lon": 8.762}],
         "tags": {"railway": "platform_edge", "ref": "1", "height": "0.76"}},
    ]}
    observations = parse_osm_friedberg(payload)
    assert any(item.object_key == ROOT_OBJECT_KEY and item.attribute == "latitude" for item in observations)
    lift = next(item for item in observations if item.attribute == "equipment_type")
    assert lift.value == "LiftEquipment"
    assert lift.metadata["parent_object_key"] == ROOT_OBJECT_KEY
    assert lift.source_publisher == "OpenStreetMap contributors"
    station_number = next(item for item in observations if item.attribute == "station_number")
    assert station_number.value == 1930
    edge = [item for item in observations if item.object_key == "FRI-PE-1"]
    assert next(item.value for item in edge if item.attribute == "platform_height") == 760
    length = next(item for item in edge if item.attribute == "construction_length")
    assert length.is_derived and length.method == "geometry_calculation"
    assert next(item.value for item in edge if item.attribute == "start_coordinates") == {"latitude": 50.332, "longitude": 8.761}


def test_stada_maps_master_data_and_rejects_bavaria():
    payload = {"number": 1930, "name": "Friedberg (Hess)", "category": 3, "hasWiFi": True,
               "evaNumbers": [{"number": 8000111, "isMain": True,
                               "geographicCoordinates": {"coordinates": [8.76, 50.33]}}],
               "ril100Identifiers": [{"rilIdentifier": "FFG", "isMain": True}],
               "mailingAddress": {"city": "Friedberg", "zipcode": "61169", "street": "Hanauer Straße 44"}}
    observations = parse_stada_station(payload)
    assert {item.attribute for item in observations} >= {"latitude", "longitude", "has_wi_fi", "street"}
    payload["name"] = "Friedberg (Bay)"
    assert parse_stada_station(payload) == []


def test_stada_accepts_wrapped_result_and_string_station_number():
    station = {"number": "1930", "name": "Friedberg (Hessen)",
               "evaNumbers": [{"number": "8000111", "isMain": True}],
               "ril100Identifiers": [{"rilIdentifier": "FFG", "isMain": True}]}
    observations = parse_stada_station({"result": [station]})
    assert next(item.value for item in observations if item.attribute == "station_number") == 1930


def test_fasta_creates_separate_facility_observations():
    payload = {"facilities": [{"equipmentnumber": 4711, "stationnumber": 1930, "type": "ELEVATOR",
                               "state": "ACTIVE", "description": "Aufzug zu Gleis 1",
                               "geocoordX": 8.76, "geocoordY": 50.33}]}
    observations = parse_fasta_facilities(payload)
    assert len(observations) == 5
    assert {item.object_key for item in observations} == {"FRI-FASTA-4711"}
    assert next(item.value for item in observations if item.attribute == "operational_state") == "ACTIVE"
