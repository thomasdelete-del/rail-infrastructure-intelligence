from dataclasses import asdict

from app.collectors.base import Collector
from app.repository import load_observations, store_observations
from app.services.compare import compare_observations


async def build_change_report(collector: Collector, station: str, persist: bool = False) -> dict:
    collected = await collector.collect(station)
    incoming = [asdict(item) for item in collected]
    # Object keys are global. Include other sources so conflicting evidence is
    # surfaced and retained instead of silently isolated by collector.
    stored = load_observations()
    comparison = compare_observations(stored, incoming)

    to_store = list(comparison["new"])
    to_store.extend(item["incoming"] for item in comparison["changed"])
    # Conflicts are evidence too: retain them instead of selecting a winner.
    to_store.extend(item["incoming"] for item in comparison["conflicts"])
    stored_count = store_observations(to_store) if persist and to_store else 0

    return {
        "station": station,
        "collector": collector.name,
        "observations_received": len(incoming),
        "summary": {key: len(value) for key, value in comparison.items()},
        "persist_requested": persist,
        "observations_stored": stored_count,
        "changes": comparison,
    }
