from datetime import date
from typing import Any


def observation_is_valid(observation: dict[str, Any], at: date) -> bool:
    valid_from = observation.get("valid_from")
    valid_to = observation.get("valid_to")
    if valid_from and date.fromisoformat(valid_from[:10]) > at:
        return False
    if valid_to and date.fromisoformat(valid_to[:10]) < at:
        return False
    return True


def resolve_state(observations: list[dict[str, Any]], at: date) -> list[dict[str, Any]]:
    """Return all observations valid at a date without hiding conflicts.

    Multiple values for the same object/attribute intentionally remain in the
    result. Consumers can inspect provenance and quality instead of receiving
    a silently selected 'truth'.
    """
    return [item for item in observations if observation_is_valid(item, at)]
