from dataclasses import asdict

from app.collectors.base import Collector
from app.services.compare import compare_observations


async def build_change_report(collector: Collector, station: str, stored: list[dict]) -> dict:
    """Collect current source observations and compare them with stored evidence."""
    collected = await collector.collect(station)
    incoming = [asdict(item) for item in collected]
    comparison = compare_observations(stored, incoming)
    return {
        "station": station,
        "collector": collector.name,
        "observations_received": len(incoming),
        "summary": {key: len(value) for key, value in comparison.items()},
        "changes": comparison,
    }
