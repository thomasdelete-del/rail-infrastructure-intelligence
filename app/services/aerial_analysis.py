from __future__ import annotations

import asyncio
from math import atan, cos, degrees, exp, log, pi, radians
from time import monotonic
from typing import Any

import cv2
import httpx
import numpy as np

from app.collectors.osm import OpenStreetMapCollector, parse_osm_friedberg
from app.services.aerial_learning import latest_correction, learned_probability
from app.services.osm_platforms import load_osm_platforms


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
    paired_geometry: list[dict[str, float]] | None = None,
) -> dict[str, Any]:
    """Detect long image edges parallel to the OSM platform axis.

    The result is advisory. It deliberately does not mutate or persist source data.
    """
    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or len(geometry) < 2:
        return {"status": "insufficient_evidence", "confidence": 0.0, "reason": "Luftbild oder OSM-Geometrie fehlt"}

    height, width = image.shape[:2]
    min_x, min_y, max_x, max_y = bbox
    # EPSG:3857 is conformal but its scale is enlarged by sec(latitude).
    # Keep WMS coordinates in Web Mercator and convert every analysed distance
    # back to local ground metres. At Friedberg the otherwise resulting error
    # is roughly +57 percent.
    ground_scale = cos(radians(sum(point["lat"] for point in geometry) / len(geometry)))
    start_xy = np.array(_mercator(geometry[0]["lat"], geometry[0]["lon"]), dtype=float)
    end_xy = np.array(_mercator(geometry[-1]["lat"], geometry[-1]["lon"]), dtype=float)
    axis = end_xy - start_xy
    mercator_length = float(np.linalg.norm(axis))
    osm_length = mercator_length * ground_scale
    if osm_length < 1:
        return {"status": "insufficient_evidence", "confidence": 0.0, "reason": "OSM-Achse ist zu kurz"}
    axis /= mercator_length
    second_xy = np.array(_mercator(geometry[1]["lat"], geometry[1]["lon"]), dtype=float)
    penultimate_xy = np.array(_mercator(geometry[-2]["lat"], geometry[-2]["lon"]), dtype=float)
    start_axis = second_xy - start_xy
    end_axis = end_xy - penultimate_xy
    start_axis /= np.linalg.norm(start_axis)
    end_axis /= np.linalg.norm(end_axis)

    def xy_to_pixel(point: np.ndarray) -> tuple[float, float]:
        return ((point[0] - min_x) / (max_x - min_x) * width,
                (max_y - point[1]) / (max_y - min_y) * height)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    gradient_x = cv2.Sobel(blurred, cv2.CV_32F, 1, 0, ksize=3)
    gradient_y = cv2.Sobel(blurred, cv2.CV_32F, 0, 1, ksize=3)

    paired_segments: list[tuple[np.ndarray, np.ndarray]] = []
    if paired_geometry:
        paired_points = [np.array(_mercator(point["lat"], point["lon"]), dtype=float) for point in paired_geometry]
        paired_segments = list(zip(paired_points, paired_points[1:]))

    def paired_lateral_offset(point: np.ndarray, normal: np.ndarray) -> float | None:
        nearest: np.ndarray | None = None
        nearest_distance = float("inf")
        for segment_start, segment_end in paired_segments:
            segment = segment_end - segment_start
            denominator = float(np.dot(segment, segment))
            if denominator == 0:
                continue
            position = max(0.0, min(1.0, float(np.dot(point - segment_start, segment) / denominator)))
            projected = segment_start + segment * position
            distance = float(np.linalg.norm(projected - point))
            if distance < nearest_distance:
                nearest, nearest_distance = projected, distance
        if nearest is None:
            return None
        lateral = float(np.dot(nearest - point, normal)) * ground_scale
        return lateral if 3.0 <= abs(lateral) <= 18.0 else None

    def detect_endpoint(origin: np.ndarray, search_axis: np.ndarray, interior_sign: int) -> tuple[np.ndarray, float, float, float] | None:
        local_normal = np.array([-search_axis[1], search_axis[0]])
        origin_px = np.array(xy_to_pixel(origin))
        direction_px = np.array(xy_to_pixel(origin + search_axis)) - origin_px
        direction_px /= np.linalg.norm(direction_px)
        directional_gradient = np.abs(gradient_x * direction_px[0] + gradient_y * direction_px[1])
        interior_extent = min(180.0, max(45.0, osm_length * 0.48))
        if interior_sign > 0:
            offsets = np.arange(-30.0, interior_extent + 0.25, 0.5)
        else:
            offsets = np.arange(-interior_extent, 30.25, 0.5)
        lateral_offsets = np.linspace(-6.0, 6.0, 25)
        scores: list[float] = []
        for offset in offsets:
            samples = np.array([
                xy_to_pixel(origin + search_axis * (offset / ground_scale) + local_normal * (lateral / ground_scale))
                for lateral in lateral_offsets
            ])
            values = cv2.remap(directional_gradient, samples[:, 0].astype(np.float32).reshape(1, -1),
                               samples[:, 1].astype(np.float32).reshape(1, -1), cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)
            halfway = values.shape[1] // 2
            scores.append(max(float(np.mean(values[:, :halfway + 1])),
                              float(np.mean(values[:, halfway:]))))
        smoothed = cv2.GaussianBlur(np.array(scores, dtype=np.float32).reshape(1, -1), (9, 1), 0).ravel()
        baseline, spread = float(np.median(smoothed)), float(np.std(smoothed))
        local_maxima = np.flatnonzero(
            (smoothed[1:-1] >= smoothed[:-2]) & (smoothed[1:-1] >= smoothed[2:])
        ) + 1
        ranked_candidates = sorted(local_maxima, key=lambda index: float(smoothed[index]), reverse=True)[:30]
        detections: list[tuple[float, np.ndarray, float, float, float]] = []
        for peak_index in ranked_candidates:
            shift = float(offsets[peak_index])
            prominence = (float(smoothed[peak_index]) - baseline) / max(spread, 1.0)
            required_prominence = 1.4 if abs(shift) <= 3 else 2.0
            if prominence < required_prominence:
                continue
            candidate = origin + search_axis * (shift / ground_scale)

            # A transverse image edge alone may be a sleeper, cable duct or shadow.
            # A real termination also ends the longitudinal platform boundaries.
            normal_px = np.array(xy_to_pixel(candidate + local_normal)) - np.array(xy_to_pixel(candidate))
            normal_px /= np.linalg.norm(normal_px)
            longitudinal_gradient = np.abs(gradient_x * normal_px[0] + gradient_y * normal_px[1])

            def boundary_strength(direction: int, lateral: float) -> float:
                longitudinal = np.linspace(4.0, 18.0, 15) * direction
                lateral_band = np.linspace(lateral - 1.5, lateral + 1.5, 7)
                samples = np.array([
                    xy_to_pixel(candidate + search_axis * (distance / ground_scale) + local_normal * (side / ground_scale))
                    for distance in longitudinal for side in lateral_band
                ])
                values = cv2.remap(longitudinal_gradient, samples[:, 0].astype(np.float32).reshape(1, -1),
                                   samples[:, 1].astype(np.float32).reshape(1, -1), cv2.INTER_LINEAR,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=0)
                return float(np.mean(values))

            corridor_offset = paired_lateral_offset(candidate, local_normal)
            lateral_sections = (0.0, corridor_offset * 0.5, corridor_offset) if corridor_offset is not None else (-4.0, 0.0, 4.0)
            ratios = []
            for lateral in lateral_sections:
                inside = boundary_strength(interior_sign, lateral)
                outside = boundary_strength(-interior_sign, lateral)
                ratios.append((inside + 4.0) / (outside + 4.0))
            termination_ratio = sorted(ratios)[-2]
            if termination_ratio < 1.18:
                continue
            # Distance is not a veto. Strong, corroborated evidence may correct
            # an OSM endpoint far inside the mapped platform edge.
            evidence_score = prominence + min(termination_ratio - 1.0, 2.0) * 2.0
            detections.append((evidence_score, candidate, shift, prominence, termination_ratio))
        if not detections:
            return None
        _, candidate, shift, prominence, termination_ratio = max(detections, key=lambda item: item[0])
        return candidate, shift, prominence, termination_ratio

    start_detection = detect_endpoint(start_xy, start_axis, 1)
    end_detection = detect_endpoint(end_xy, end_axis, -1)
    def detection_features(detection: tuple[np.ndarray, float, float, float]) -> dict[str, Any]:
        return {"shift_m": round(detection[1], 1), "prominence": round(detection[2], 3),
                "termination_ratio": round(detection[3], 3), "paired_corridor": bool(paired_geometry)}
    def endpoint_confidence(detection: tuple[np.ndarray, float, float, float]) -> float:
        _, shift, prominence, termination_ratio = detection
        osm_prior = 0.45 if abs(shift) <= 3 else 0.0
        termination_evidence = min(0.25, max(0.0, termination_ratio - 1.0) / 2)
        return round(min(0.9, osm_prior + prominence / 8 + termination_evidence), 2)

    if not start_detection or not end_detection:
        result: dict[str, Any] = {"status": "insufficient_evidence", "confidence": 0.0,
                                  "reason": "Nur einer oder keiner der beiden OSM-Endpunkte ist im Luftbild eindeutig bestätigt",
                                  "method": "OSM-zentrierte lokale Endpunktprüfung; Anfang und Ende getrennt"}
        if start_detection:
            result.update(candidate_start=_latlon(*start_detection[0]), start_shift_m=round(start_detection[1], 1),
                          start_confidence=endpoint_confidence(start_detection),
                          start_termination_ratio=round(start_detection[3], 2),
                          start_features=detection_features(start_detection))
        if end_detection:
            result.update(candidate_end=_latlon(*end_detection[0]), end_shift_m=round(end_detection[1], 1),
                          end_confidence=endpoint_confidence(end_detection),
                          end_termination_ratio=round(end_detection[3], 2),
                          end_features=detection_features(end_detection))
        return result
    candidate_start_xy, start_shift, start_prominence, start_termination = start_detection
    candidate_end_xy, end_shift, end_prominence, end_termination = end_detection
    candidate_length = float(np.linalg.norm(candidate_end_xy - candidate_start_xy)) * ground_scale
    endpoint_shift = max(abs(start_shift), abs(end_shift))
    length_delta = candidate_length - osm_length
    start_confidence = endpoint_confidence(start_detection)
    end_confidence = endpoint_confidence(end_detection)
    confidence = min(start_confidence, end_confidence)
    status = "plausible" if endpoint_shift <= 3 else "check"
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
        "start_confidence": start_confidence,
        "end_confidence": end_confidence,
        "start_termination_ratio": round(start_termination, 2),
        "end_termination_ratio": round(end_termination, 2),
        "start_features": detection_features(start_detection),
        "end_features": detection_features(end_detection),
        "method": "Bahnsteigkorridor-Prüfung: Querabschluss und Abbruch beider seitlichen Begrenzungen",
    }


async def analyse_osm_platform(
    track: str,
    station_name: str = "Friedberg (Hess)",
    latitude: float | None = None,
    longitude: float | None = None,
    start_latitude: float | None = None,
    start_longitude: float | None = None,
    end_latitude: float | None = None,
    end_longitude: float | None = None,
) -> dict[str, Any]:
    global _OSM_CACHE
    generic_station = latitude is not None and longitude is not None
    if generic_station:
        payload = await load_osm_platforms(float(latitude), float(longitude))
    else:
        async with _OSM_CACHE_LOCK:
            if _OSM_CACHE is None or monotonic() - _OSM_CACHE[0] > 300:
                _OSM_CACHE = (monotonic(), await OpenStreetMapCollector().fetch())
            payload = _OSM_CACHE[1]
        if not parse_osm_friedberg(payload):
            raise ValueError("OSM-Datensatz besteht die Identitätsprüfung Friedberg (Hess) nicht")
    candidates = [element for element in payload.get("elements", [])
                  if element.get("tags", {}).get("railway") in {"platform", "platform_edge"}
                  and str(element.get("tags", {}).get("ref", "")).casefold() == track.casefold()
                  and len(element.get("geometry", [])) >= 2]
    if len(candidates) != 1:
        raise LookupError(f"Für Gleis {track} wurde keine eindeutige OSM-Bahnsteigkante gefunden")
    element = candidates[0]
    geometry = element["geometry"]
    if element.get("tags", {}).get("railway") == "platform" and len(geometry) > 2:
        geometry = max(((start, end) for index, start in enumerate(geometry) for end in geometry[index + 1:]), key=lambda pair: np.linalg.norm(np.array(_mercator(pair[0]["lat"], pair[0]["lon"])) - np.array(_mercator(pair[1]["lat"], pair[1]["lon"]))))
        geometry = list(geometry)
    else:
        geometry = [dict(point) for point in geometry]
    if start_latitude is not None and start_longitude is not None:
        geometry[0] = {"lat": start_latitude, "lon": start_longitude}
    if end_latitude is not None and end_longitude is not None:
        geometry[-1] = {"lat": end_latitude, "lon": end_longitude}
    paired_tracks = {"1": "1a", "1a": "1", "2": "4", "4": "2", "5": "7", "7": "5",
                     "8": "10", "10": "8", "11": "12", "12": "11"}
    paired_track = paired_tracks.get(track.casefold()) if not generic_station else None
    paired_candidates = [candidate for candidate in payload.get("elements", [])
                         if candidate.get("tags", {}).get("railway") == "platform_edge"
                         and str(candidate.get("tags", {}).get("ref", "")).casefold() == paired_track
                         and len(candidate.get("geometry", [])) >= 2]
    paired_geometry = paired_candidates[0]["geometry"] if len(paired_candidates) == 1 else None
    all_geometry = geometry + (paired_geometry or [])
    points = [_mercator(point["lat"], point["lon"]) for point in all_geometry]
    ground_scale = cos(radians(sum(point["lat"] for point in geometry) / len(geometry)))
    margin = 25.0 / ground_scale
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
    result = analyse_platform_crop(response.content, bbox, geometry, paired_geometry)
    for endpoint in ("start", "end"):
        features = result.get(f"{endpoint}_features")
        if features:
            try:
                probability, sample_count = learned_probability(features)
            except RuntimeError:
                probability, sample_count = None, 0
            result[f"{endpoint}_learned_probability"] = probability
            result["training_sample_count"] = sample_count
    try:
        learning_track = f"{station_name}:{track}" if generic_station else track
        corrections = {endpoint: latest_correction(learning_track, endpoint) for endpoint in ("start", "end")}
    except RuntimeError:
        corrections = {"start": None, "end": None}
    original_points = {
        "start": np.array(_mercator(geometry[0]["lat"], geometry[0]["lon"]), dtype=float),
        "end": np.array(_mercator(geometry[-1]["lat"], geometry[-1]["lon"]), dtype=float),
    }
    for endpoint, correction in corrections.items():
        if not correction:
            continue
        corrected_xy = np.array(_mercator(correction["latitude"], correction["longitude"]), dtype=float)
        result[f"candidate_{endpoint}"] = correction
        result[f"{endpoint}_shift_m"] = round(float(np.linalg.norm(corrected_xy - original_points[endpoint])) * ground_scale, 1)
        result[f"{endpoint}_human_confirmed"] = True
    if result.get("candidate_start") and result.get("candidate_end"):
        corrected_start = result["candidate_start"]
        corrected_end = result["candidate_end"]
        start_metric = np.array(_mercator(corrected_start["latitude"], corrected_start["longitude"]), dtype=float)
        end_metric = np.array(_mercator(corrected_end["latitude"], corrected_end["longitude"]), dtype=float)
        _recompute_candidate_metrics(
            result, start_metric, end_metric, ground_scale,
            float(result["osm_chord_length_m"]),
        )
    result.update({
        "station": station_name, "track": track,
        "osm": {"type": element["type"], "id": element["id"], "url": f"https://www.openstreetmap.org/{element['type']}/{element['id']}"},
        "provenance": {"publisher": "Hessische Verwaltung für Bodenmanagement und Geoinformation",
                       "source": "Geodatenviewer Hessen DOP20", "wms_url": WMS_URL, "layer": WMS_LAYER,
                       "paired_track_for_corridor": paired_track if paired_geometry else None,
                       "bbox_epsg_3857": [round(value, 2) for value in bbox], "image_size": [width, height]},
        "advisory_only": True,
    })
    return result


def _recompute_candidate_metrics(
    result: dict[str, Any], start_metric: np.ndarray, end_metric: np.ndarray,
    ground_scale: float, osm_length: float,
) -> None:
    """Keep aggregate review values consistent after candidates are replaced."""
    candidate_length = float(np.linalg.norm(end_metric - start_metric)) * ground_scale
    result["candidate_length_m"] = round(candidate_length, 1)
    result["length_delta_m"] = round(candidate_length - osm_length, 1)
    endpoint_shifts = [
        abs(float(result[key]))
        for key in ("start_shift_m", "end_shift_m")
        if result.get(key) is not None
    ]
    if endpoint_shifts:
        maximum_shift = max(endpoint_shifts)
        result["maximum_endpoint_shift_m"] = round(maximum_shift, 1)
        result["status"] = "plausible" if maximum_shift <= 3 else "check"
