from collections import defaultdict
from typing import Any


def observation_key(item: dict[str, Any]) -> tuple[str, str]:
    return item["object_key"], item["attribute"]


def compare_observations(stored: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Classify incoming evidence without overwriting stored observations."""
    index = defaultdict(list)
    for item in stored:
        index[observation_key(item)].append(item)

    result = {"new": [], "unchanged": [], "changed": [], "conflicts": []}
    for item in incoming:
        existing = index.get(observation_key(item), [])
        if not existing:
            result["new"].append(item)
            continue
        same_source = [old for old in existing if old.get("source_key") == item.get("source_key")]
        if not same_source:
            matches = [old for old in existing if old.get("value") == item.get("value") and old.get("unit") == item.get("unit")]
            if matches:
                # The value is corroborated, but this source's provenance is new.
                result["new"].append(item)
            else:
                result["conflicts"].append({"incoming": item, "existing": existing})
            continue
        latest = same_source[-1]
        if latest.get("value") == item.get("value") and latest.get("unit") == item.get("unit"):
            result["unchanged"].append({"incoming": item, "matches": [latest]})
            continue
        record = {"incoming": item, "existing": existing}
        result["changed"].append(record)
    return result
