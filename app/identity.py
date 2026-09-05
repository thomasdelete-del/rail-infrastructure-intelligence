from dataclasses import dataclass


@dataclass(frozen=True)
class StationIdentity:
    station_id: str
    station_number: int
    name: str
    city: str
    state: str


FRIEDBERG_HESS = StationIdentity(
    station_id="DE-FRI-HESS-1930",
    station_number=1930,
    name="Friedberg (Hess)",
    city="Friedberg (Hessen)",
    state="Hessen",
)


def is_friedberg_hess(name: str, station_number: int | None = None) -> bool:
    normalized = " ".join(name.casefold().split())
    valid_names = {"friedberg (hess)", "friedberg hess", "friedberg (hessen)", "friedberg hessen"}
    if normalized not in valid_names:
        return False
    return station_number in (None, FRIEDBERG_HESS.station_number)
