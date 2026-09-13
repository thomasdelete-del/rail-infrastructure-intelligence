import asyncio
import httpx
from app.services import osm_rounds


def test_retries_only_failed_states_in_next_round(monkeypatch):
    monkeypatch.setattr(osm_rounds, "STATE_CODES", ("DE-HE", "DE-BW", "DE-BY"))
    calls, saved = [], []
    async def fetch(code):
        calls.append(code)
        if code == "DE-HE" and calls.count(code) == 1:
            raise httpx.ReadTimeout("busy")
        return code
    async def save(code, result):
        saved.append(code)
    pending = asyncio.run(osm_rounds.load_state_rounds(fetch, save, request_pause=0, round_pause=0))
    assert calls == ["DE-HE", "DE-BW", "DE-BY", "DE-HE"]
    assert saved == ["DE-BW", "DE-BY", "DE-HE"]
    assert pending == []
