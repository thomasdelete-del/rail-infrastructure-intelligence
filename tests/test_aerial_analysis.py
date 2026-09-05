import cv2
import numpy as np

from app.services.aerial_analysis import _latlon, _recompute_candidate_metrics, analyse_platform_crop


def _geometry_point(x: float, y: float) -> dict[str, float]:
    coordinate = _latlon(x, y)
    return {"lat": coordinate["latitude"], "lon": coordinate["longitude"]}


def test_detects_parallel_aerial_edges_and_proposes_longer_extent():
    bbox = (0.0, 0.0, 200.0, 80.0)
    image = np.full((400, 1000, 3), 115, dtype=np.uint8)
    cv2.line(image, (100, 180), (900, 180), (245, 245, 245), 4)
    cv2.line(image, (100, 220), (900, 220), (235, 235, 235), 4)
    ok, encoded = cv2.imencode(".png", image)
    assert ok

    result = analyse_platform_crop(
        encoded.tobytes(), bbox,
        [_geometry_point(40, 40), _geometry_point(160, 40)],
    )

    assert result["status"] == "check"
    assert result["candidate_length_m"] > result["osm_chord_length_m"]
    assert abs(result["start_shift_m"]) > 8
    assert abs(result["end_shift_m"]) > 8


def test_returns_insufficient_evidence_for_blank_crop():
    image = np.full((300, 600, 3), 128, dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok

    result = analyse_platform_crop(
        encoded.tobytes(), (0.0, 0.0, 120.0, 60.0),
        [_geometry_point(20, 30), _geometry_point(100, 30)],
    )

    assert result["status"] == "insufficient_evidence"
    assert result["confidence"] == 0


def test_confirms_endpoints_only_when_longitudinal_edges_terminate_there():
    bbox = (0.0, 0.0, 200.0, 80.0)
    image = np.full((400, 1000, 3), 105, dtype=np.uint8)
    cv2.rectangle(image, (200, 180), (800, 220), (205, 205, 205), -1)
    cv2.line(image, (200, 180), (800, 180), (250, 250, 250), 5)
    cv2.line(image, (200, 220), (800, 220), (245, 245, 245), 5)
    cv2.line(image, (200, 180), (200, 220), (245, 245, 245), 5)
    cv2.line(image, (800, 180), (800, 220), (245, 245, 245), 5)
    ok, encoded = cv2.imencode(".png", image)
    assert ok

    result = analyse_platform_crop(
        encoded.tobytes(), bbox,
        [_geometry_point(40, 36), _geometry_point(160, 36)],
        [_geometry_point(40, 44), _geometry_point(160, 44)],
    )

    assert result["status"] == "plausible"
    assert result["start_termination_ratio"] >= 1.18
    assert result["end_termination_ratio"] >= 1.18
    assert "Bahnsteigkorridor" in result["method"]


def test_does_not_infer_full_length_without_visible_local_endpoints():
    bbox = (0.0, 0.0, 600.0, 100.0)
    image = np.full((400, 1200, 3), 110, dtype=np.uint8)
    cv2.line(image, (20, 180), (1180, 180), (245, 245, 245), 4)
    cv2.line(image, (20, 220), (1180, 220), (235, 235, 235), 4)
    ok, encoded = cv2.imencode(".png", image)
    assert ok

    result = analyse_platform_crop(
        encoded.tobytes(), bbox,
        [_geometry_point(100, 50), _geometry_point(500, 50)],
    )

    assert result["status"] == "insufficient_evidence"
    assert result["confidence"] == 0
    assert "eindeutig" in result["reason"]


def test_recomputes_all_aggregates_after_manual_endpoint_corrections():
    result = {
        "status": "plausible",
        "candidate_length_m": 280.0,
        "length_delta_m": 10.0,
        "maximum_endpoint_shift_m": 2.0,
        "start_shift_m": 85.2,
        "end_shift_m": 2.6,
    }

    _recompute_candidate_metrics(
        result,
        np.array([0.0, 0.0]),
        np.array([201.1, 0.0]),
        ground_scale=1.0,
        osm_length=278.8,
    )

    assert result["candidate_length_m"] == 201.1
    assert result["length_delta_m"] == -77.7
    assert result["maximum_endpoint_shift_m"] == 85.2
    assert result["status"] == "check"
