import cv2
import numpy as np

from app.services.aerial_analysis import _latlon, analyse_platform_crop


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

    assert result["status"] == "insufficient_evidence"
    assert result["confidence"] == 0
    assert "OSM-Endpunkte" in result["reason"]


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
