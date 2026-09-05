from __future__ import annotations

import asyncio
from math import atan, degrees, exp, log, pi, radians
from time import monotonic
from typing import Any

import cv2
import httpx
import numpy as np

from app.collectors.osm import OpenStreetMapCollector, parse_osm_friedberg


WMS_URL = "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows"
WMS_LAYER = "he_dop20_rgb"
EARTH_RADIUS = 6378137.0
_OSM_CACHE: tuple[float, dict[str, Any]] | None = None
_OSM_CACHE_LOCK = asyncio.Lock()


def _mercator(latitude: float, longitude: float) -> tuple[float, float]:
    latitude = max(-85.05112878, min(85.05112878, latitude))
    return EARTH_RADIUS * radians(longitude), EARTH_RADIUS * log(
        np.tan(pi / 4 + radians(latitude) / 2)
    )


def _latlon(x: float, y: float) -> dict[str, float]:
    return {
        "latitude": degrees(2 * atan(exp(y / EARTH_RADIUS)) - pi / 2),
        "longitude": degrees(x / EARTH_RADIUS),
    }


def _angle_difference(first: float, second: float) -> float:
    value = abs(first - second) % 180
    return min(value, 180 - value)


def analyse_platform_crop(
    image_bytes: bytes,
    bbox: tuple[float, float, float, float],
    geometry: list[dict[str, float]],
) -> dict[str, Any]:
    """Detect long image edges parallel to the OSM platform axis.

    The result is advisory. It deliberately does not mutate or persist source data.
    """
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or len(geometry) < 2:
        return {"status": "insufficient_evidence", "confidence": 0.0, "reason": "Luftbild oder OSM-Geometrie fehlt"}

    height, width = image.shape[:2]
    min_x, min_y, max_x, max_y = bbox
    start_xy = np.array(_mercator(geometry[0]["lat"], geometry[0]["lon"]), dtype=float)
    end_xy = np.array(_mercator(geometry[-1]["lat"], geometry[-1]["lon"]), dtype=float)
    axis = end_xy - start_xy
    osm_length = float(np.linalg.norm(axis))
    if osm_length < 1:
        return {"status": "insufficient_evidence", "confidence": 0.0, "reason": "OSM-Achse ist zu kurz"}
    axis /= osm_length
    normal = np.array([-axis[1], axis[0]])

    def pixel_to_xy(px: float, py: float) -> np.ndarray:
        return np.array([min_x + px / width * (max_x - min_x), max_y - py / height * (max_y - min_y)])

    osm_angle = degrees(np.arctan2(-(end_xy[1] - start_xy[1]), end_xy[0] - start_xy[0])) % 180
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (5, 5), 0), 45, 130)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=42,
                            minLineLength=max(35, int(min(width, height) * 0.08)), maxLineGap=22)
    accepted: list[tuple[np.ndarray, np.ndarray, float]] = []
    midpoint = (start_xy + end_xy) / 2
    if lines is not None:
        for raw in lines[:, 0]:
            x1, y1, x2, y2 = map(float, raw)
            angle = degrees(np.arctan2(y2 - y1, x2 - x1)) % 180
            if _angle_difference(angle, osm_angle) > 12:
                continue
            first, second = pixel_to_xy(x1, y1), pixel_to_xy(x2, y2)
            segment_midpoint = (first + second) / 2
            lateral = abs(float(np.dot(segment_midpoint - midpoint, normal)))
            length = float(np.linalg.norm(second - first))
            if lateral <= 18 and length >= 10:
                accepted.append((first, second, length))

    if len(accepted) < 2:
        return {"status": "insufficient_evidence", "confidence": 0.0,
                "reason": "Zu wenige parallele Luftbildkanten erkannt", "detected_segments": len(accepted)}

    projections = np.array([float(np.dot(point - midpoint, axis)) for first, second, _ in accepted for point in (first, second)])
    lower, upper = np.percentile(projections, [5, 95])
    candidate_length = float(upper - lower)
    if candidate_length < 20:
        return {"status": "insufficient_evidence", "confidence": 0.0,
                "reason": "Erkannte Kanten decken den Bahnsteig nicht ausreichend ab", "detected_segments": len(accepted)}

    candidate_start_xy = midpoint + axis * lower
    candidate_end_xy = midpoint + axis * upper
    osm_projection_start = float(np.dot(start_xy - midpoint, axis))
    osm_projection_end = float(np.dot(end_xy - midpoint, axis))
    endpoint_shift = max(abs(lower - min(osm_projection_start, osm_projection_end)),
                         abs(upper - max(osm_projection_start, osm_projection_end)))
    length_delta = candidate_length - osm_length
    coverage = min(1.0, sum(item[2] for item in accepted) / max(candidate_length * 2, 1))
    confidence = round(min(0.95, 0.25 + len(accepted) * 0.035 + coverage * 0.35), 2)
    status = "plausible" if endpoint_shift <= 5 and abs(length_delta) <= 5 else "check"
    if endpoint_shift > 15 or abs(length_delta) > 15:
        status = "high"
    return {
        "status": status,
        "confidence": confidence,
        "candidate_start": _latlon(*candidate_start_xy),
        "candidate_end": _latlon(*candidate_end_xy),
        "candidate_length_m": round(candidate_length, 1),
        "osm_chord_length_m": round(osm_length, 1),
        "length_delta_m": round(length_delta, 1),
        "maximum_endpoint_shift_m": round(endpoint_shift, 1),
        "detected_segments": len(accepted),
        "method": "OpenCV Canny + probabilistische Hough-Transformation, parallel zur OSM-Achse",
    }


async def analyse_osm_platform(track: str) -> dict[str, Any]:
    global _OSM_CACHE
    async with _OSM_CACHE_LOCK:
        if _OSM_CACHE is None or monotonic() - _OSM_CACHE[0] > 300:
            _OSM_CACHE = (monotonic(), await OpenStreetMapCollector().fetch())
        payload = _OSM_CACHE[1]
    if not parse_osm_friedberg(payload):
        raise ValueError("OSM-Datensatz besteht die Identitätsprüfung Friedberg (Hess) nicht")
    candidates = [element for element in payload.get("elements", [])
                  if element.get("tags", {}).get("railway") == "platform_edge"
                  and str(element.get("tags", {}).get("ref", "")).casefold() == track.casefold()
                  and len(element.get("geometry", [])) >= 2]
    if len(candidates) != 1:
        raise LookupError(f"Für Gleis {track} wurde keine eindeutige OSM-Bahnsteigkante gefunden")
    element = candidates[0]
    geometry = element["geometry"]
    points = [_mercator(point["lat"], point["lon"]) for point in geometry]
    margin = 25.0
    bbox = (min(point[0] for point in points) - margin, min(point[1] for point in points) - margin,
            max(point[0] for point in points) + margin, max(point[1] for point in points) + margin)
    span_x, span_y = bbox[2] - bbox[0], bbox[3] - bbox[1]
    scale = min(1536 / span_x, 1536 / span_y, 5.0)
    width, height = max(512, round(span_x * scale)), max(512, round(span_y * scale))
    params = {"SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": WMS_LAYER,
              "STYLES": "", "FORMAT": "image/png", "TRANSPARENT": "FALSE", "SRS": "EPSG:3857",
              "BBOX": ",".join(str(value) for value in bbox), "WIDTH": width, "HEIGHT": height}
    async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
        response = await client.get(WMS_URL, params=params, headers={"User-Agent": "rail-infrastructure-intelligence/1.2"})
        response.raise_for_status()
    result = analyse_platform_crop(response.content, bbox, geometry)
    result.update({
        "station": "Friedberg (Hess)", "track": track,
        "osm": {"type": element["type"], "id": element["id"], "url": f"https://www.openstreetmap.org/{element['type']}/{element['id']}"},
        "provenance": {"publisher": "Hessische Verwaltung für Bodenmanagement und Geoinformation",
                       "source": "Geodatenviewer Hessen DOP20", "wms_url": WMS_URL, "layer": WMS_LAYER,
                       "bbox_epsg_3857": [round(value, 2) for value in bbox], "image_size": [width, height]},
        "advisory_only": True,
    })
    return result
