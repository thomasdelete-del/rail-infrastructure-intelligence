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

    def xy_to_pixel(point: np.ndarray) -> tuple[float, float]:
        return ((point[0] - min_x) / (max_x - min_x) * width,
                (max_y - point[1]) / (max_y - min_y) * height)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    gradient_x = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)
    start_px, end_px = np.array(xy_to_pixel(start_xy)), np.array(xy_to_pixel(end_xy))
    pixel_axis = end_px - start_px
    pixel_axis /= np.linalg.norm(pixel_axis)
    directional_gradient = np.abs(gradient_x * pixel_axis[0] + gradient_y * pixel_axis[1])

    def detect_endpoint(origin: np.ndarray) -> tuple[np.ndarray, float, float] | None:
        offsets = np.linspace(-35.0, 35.0, 141)
        lateral_offsets = np.linspace(-5.0, 5.0, 21)
        scores: list[float] = []
        for offset in offsets:
            samples = np.array([xy_to_pixel(origin + axis * offset + normal * lateral) for lateral in lateral_offsets])
            values = cv2.remap(directional_gradient, samples[:, 0].astype(np.float32).reshape(1, -1),
                               samples[:, 1].astype(np.float32).reshape(1, -1), cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            scores.append(float(np.mean(values)))
        smoothed = cv2.GaussianBlur(np.array(scores, dtype=np.float32).reshape(1, -1), (9, 1), 0).ravel()
        peak_index = int(np.argmax(smoothed))
        baseline, spread = float(np.median(smoothed)), float(np.std(smoothed))
        prominence = (float(smoothed[peak_index]) - baseline) / max(spread, 1.0)
        if prominence < 1.8 or peak_index < 3 or peak_index > len(offsets) - 4:
            return None
        shift = float(offsets[peak_index])
        return origin + axis * shift, shift, prominence

    start_detection, end_detection = detect_endpoint(start_xy), detect_endpoint(end_xy)
    if not start_detection or not end_detection:
        return {"status": "insufficient_evidence", "confidence": 0.0,
                "reason": "Bahnsteiganfang oder Bahnsteigende ist im lokalen Luftbildausschnitt nicht eindeutig erkennbar",
                "method": "Lokale Endpunktsuche ±35 m entlang der OSM-Bahnsteigachse"}
    candidate_start_xy, start_shift, start_prominence = start_detection
    candidate_end_xy, end_shift, end_prominence = end_detection
    candidate_length = float(np.linalg.norm(candidate_end_xy - candidate_start_xy))
    endpoint_shift = max(abs(start_shift), abs(end_shift))
    length_delta = candidate_length - osm_length
    confidence = round(min(0.9, min(start_prominence, end_prominence) / 4.5), 2)
    status = "plausible" if endpoint_shift <= 3 else "check"
    if endpoint_shift > 10:
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
        "start_shift_m": round(start_shift, 1),
        "end_shift_m": round(end_shift, 1),
        "method": "Lokale Endpunktsuche ±35 m entlang der OSM-Bahnsteigachse",
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
