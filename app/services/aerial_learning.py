from __future__ import annotations

from typing import Any

import numpy as np

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


def store_training_sample(track: str, endpoint: str, accepted: bool, features: dict[str, Any]) -> int:
    return store_observations([{
        "object_key": f"FRI-OSM-platform-edge-{track}", "object_type": "platform_edge",
        "attribute": ATTRIBUTE,
        "value": {"track": track, "endpoint": endpoint, "accepted": accepted, "features": features},
        "source_key": SOURCE_KEY, "source_publisher": "Manuelle Luftbildprüfung",
        "source_type": "human_review", "quality_class": "B", "method": "supervised_label",
        "is_derived": False,
        "metadata": {"station": "Friedberg (Hess)", "imagery": "Hessen DOP20"},
    }])


def training_samples() -> list[dict[str, Any]]:
    return [row["value"] for row in load_observations(SOURCE_KEY)
            if row.get("attribute") == ATTRIBUTE and isinstance(row.get("value"), dict)]


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
