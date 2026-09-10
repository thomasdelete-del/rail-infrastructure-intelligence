from __future__ import annotations

from typing import Any

import numpy as np
from sqlalchemy import text

from app.database import get_engine
from app.repository import load_observations, store_observations

SOURCE_KEY = "human-aerial-endpoint-review"
ATTRIBUTE = "aerial_endpoint_training_sample"


def feature_vector(features: dict[str, Any]) -> np.ndarray:
    return np.array([
        min(float(features.get("prominence", 0.0)), 8.0) / 8.0,
        min(float(features.get("termination_ratio", 1.0)), 5.0) / 5.0,
        min(abs(float(features.get("shift_m", 0.0))), 180.0) / 180.0,
        1.0 if features.get("paired_corridor") else 0.0,
    ], dtype=float)


def store_training_sample(track: str, endpoint: str, accepted: bool, features: dict[str, Any],
                          corrected_coordinate: dict[str, float] | None = None,
                          confirmed_coordinate: dict[str, float] | None = None,
                          clear_corrected_coordinate: bool = False,
                          promote_to_primary: bool = False) -> int:
    observations = [{
        "object_key": f"FRI-OSM-platform-edge-{track}", "object_type": "platform_edge",
        "attribute": ATTRIBUTE,
        "value": {"track": track, "endpoint": endpoint, "accepted": accepted, "features": features,
                  "corrected_coordinate": corrected_coordinate,
                  "clear_corrected_coordinate": clear_corrected_coordinate},
        "source_key": SOURCE_KEY, "source_publisher": "Manuelle Luftbildprüfung",
        "source_type": "human_review", "quality_class": "B", "method": "supervised_label",
        "is_derived": False,
        "metadata": {"station": "Friedberg (Hess)", "imagery": "Hessen DOP20"},
    }]
    if accepted and confirmed_coordinate:
        observations.append({
            "object_key": f"FRI-OSM-platform-edge-{track}", "object_type": "platform_edge",
            "attribute": f"confirmed_{endpoint}_coordinates", "value": confirmed_coordinate,
            "source_key": SOURCE_KEY, "source_publisher": "Manuelle Luftbildprüfung",
            "source_type": "human_review", "quality_class": "B", "method": "manual_confirmation",
            "is_derived": False, "note": "OSM-Endpunkt im amtlichen Luftbild bestätigt",
            "metadata": {"station": "Friedberg (Hess)", "imagery": "Hessen DOP20",
                         "original_source": "OpenStreetMap", "endpoint": endpoint},
        })
    if promote_to_primary and corrected_coordinate:
        observations.append({
            "object_key": f"FRI-OSM-platform-edge-{track}", "object_type": "platform_edge",
            "attribute": f"primary_{endpoint}_coordinates", "value": corrected_coordinate,
            "source_key": SOURCE_KEY, "source_publisher": "Manuelle Luftbildprüfung",
            "source_type": "human_review", "quality_class": "A", "method": "approved_primary_coordinate",
            "is_derived": False, "note": "Nach ausdrücklicher Freigabe als primärer Bahnsteigkantenpunkt gespeichert",
            "metadata": {"station": track.rsplit(":", 1)[0] if ":" in track else "Friedberg (Hess)",
                         "endpoint": endpoint, "approval": "explicit_user_confirmation",
                         "replaces": "OpenStreetMap endpoint for application display"},
        })
    return store_observations(observations)


def training_samples() -> list[dict[str, Any]]:
    return [row["value"] for row in load_observations(SOURCE_KEY)
            if row.get("attribute") == ATTRIBUTE and isinstance(row.get("value"), dict)]


def latest_correction(track: str, endpoint: str) -> dict[str, float] | None:
    for sample in reversed(training_samples()):
        if sample.get("track") != track or sample.get("endpoint") != endpoint:
            continue
        if sample.get("clear_corrected_coordinate"):
            return None
        coordinate = sample.get("corrected_coordinate")
        if isinstance(coordinate, dict):
            return {"latitude": float(coordinate["latitude"]), "longitude": float(coordinate["longitude"])}
    return None


def delete_station_endpoint_changes(station: str) -> int:
    """Delete only manually changed endpoints for one station from Railway."""
    statement = text('''
        DELETE FROM observation AS o
        USING source AS s
        WHERE o.source_id = s.id
          AND s.source_key = :source_key
          AND (
            (
              o.attribute = :training_attribute
              AND o.value_json ->> 'track' LIKE :track_prefix
              AND o.value_json -> 'corrected_coordinate' IS NOT NULL
              AND o.value_json -> 'corrected_coordinate' <> 'null'::jsonb
            )
            OR (
              o.attribute IN ('primary_start_coordinates', 'primary_end_coordinates')
              AND o.provenance ->> 'station' = :station
            )
          )
    ''')
    with get_engine().begin() as connection:
        result = connection.execute(statement, {
            "source_key": SOURCE_KEY,
            "training_attribute": ATTRIBUTE,
            "track_prefix": f"{station}:%",
            "station": station,
        })
    return int(result.rowcount or 0)


def learned_probability(features: dict[str, Any]) -> tuple[float | None, int]:
    samples = training_samples()
    labels = np.array([1.0 if sample.get("accepted") else 0.0 for sample in samples], dtype=float)
    if len(samples) < 6 or len(set(labels.tolist())) < 2:
        return None, len(samples)
    matrix = np.vstack([feature_vector(sample.get("features", {})) for sample in samples])
    matrix = np.column_stack([np.ones(len(matrix)), matrix])
    weights = np.zeros(matrix.shape[1], dtype=float)
    for _ in range(300):
        probability = 1.0 / (1.0 + np.exp(-np.clip(matrix @ weights, -20, 20)))
        weights -= 0.35 * ((matrix.T @ (probability - labels)) / len(labels) + 0.01 * weights)
    candidate = np.insert(feature_vector(features), 0, 1.0)
    probability = 1.0 / (1.0 + np.exp(-float(candidate @ weights)))
    return round(float(probability), 3), len(samples)
