import asyncio
from dataclasses import dataclass

from app.collectors.base import CollectedObservation
from app.services import change_report


@dataclass
class FixtureCollector:
    name: str = "fixture"
    source_key: str = "openstation"

    async def collect(self, station):
        return [CollectedObservation(object_key="edge-1", object_type="platform_edge", attribute="name", value="1",
            unit=None, source_key=self.source_key, source_url="https://example.test/netex",
            metadata={"netex_id": "edge-1", "netex_type": "Quay"})]


def test_change_report_persists_conflicting_evidence(monkeypatch):
    existing = {"object_key": "edge-1", "object_type": "platform_edge", "attribute": "name",
                "value": "old", "unit": None, "source_key": "other-source"}
    monkeypatch.setattr(change_report, "load_observations", lambda: [existing])
    stored = []
    monkeypatch.setattr(change_report, "store_observations", lambda items: stored.extend(items) or len(items))
    report = asyncio.run(change_report.build_change_report(FixtureCollector(), "Friedberg (Hess)", persist=True))
    assert report["summary"]["conflicts"] == report["observations_stored"] == 1
    assert stored[0]["metadata"]["netex_id"] == "edge-1"


def test_change_report_does_not_store_unchanged_observation(monkeypatch):
    existing = {"object_key": "edge-1", "object_type": "platform_edge", "attribute": "name",
                "value": "1", "unit": None, "source_key": "openstation"}
    monkeypatch.setattr(change_report, "load_observations", lambda: [existing])
    monkeypatch.setattr(change_report, "store_observations", lambda items: (_ for _ in ()).throw(AssertionError()))
    report = asyncio.run(change_report.build_change_report(FixtureCollector(), "Friedberg (Hess)", persist=True))
    assert report["summary"]["unchanged"] == 1
    assert report["observations_stored"] == 0
