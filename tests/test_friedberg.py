from app.identity import is_friedberg_hess
from app.seed.friedberg import FRIEDBERG
from app.seed.friedberg_service_tracks import FRIEDBERG_SERVICE_TRACK_CONFLICTS


def test_station_identity():
    assert FRIEDBERG["station_number"] == 1930
    assert FRIEDBERG["name"] == "Friedberg (Hess)"


def test_rejects_other_friedbergs():
    assert is_friedberg_hess("Friedberg (Hess)", 1930)
    assert not is_friedberg_hess("Friedberg (b Augsburg)")
    assert not is_friedberg_hess("Friedberg Süd")


def test_accepts_unabbreviated_hessen_with_station_number():
    assert is_friedberg_hess("Friedberg (Hessen)", 1930)


def test_complete_platform_edge_inventory():
    tracks = {edge["track"] for edge in FRIEDBERG["platform_edges"]}
    assert tracks == {"1", "1a", "2", "4", "5", "7", "8", "10", "11", "12"}
    assert len(FRIEDBERG["platform_edges"]) == 10


def test_all_platform_observations_have_sources():
    for edge in FRIEDBERG["platform_edges"]:
        for observation in edge["observations"]:
            assert observation.get("source_id")


def test_track_55_anomaly_is_not_silently_corrected():
    conflict = FRIEDBERG_SERVICE_TRACK_CONFLICTS[0]
    assert conflict["object_id"] == "FRI-SERVICE-TRACK-55"
    assert conflict["published_value"] == 730
    assert conflict["status"] == "needs_verification"
