import asyncio
import httpx

STATE_CODES = tuple('DE-' + code for code in (
    'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
    'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH',
))


async def load_state_rounds(fetch_once, on_success, *, max_rounds=10,
                            request_pause=20, round_pause=60):
    """One attempt/state/round; retain successful results immediately."""
    pending = list(STATE_CODES)
    for round_number in range(max_rounds):
        failed = []
        for index, code in enumerate(pending):
            try:
                result = await fetch_once(code)
                await on_success(code, result)
            except (httpx.HTTPError, ValueError, KeyError):
                failed.append(code)
            if index < len(pending) - 1:
                await asyncio.sleep(request_pause)
        pending = failed
        if not pending:
            break
        if round_number < max_rounds - 1:
            await asyncio.sleep(round_pause)
    return pending
