from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CollectedObservation:
    object_key: str
    object_type: str
    attribute: str
    value: Any
    unit: str | None
    source_key: str
    source_url: str
    source_publisher: str = "Unknown"
    source_type: str = "external"
    source_date: str | None = None
    quality_class: str = "F"
    is_derived: bool = False
    method: str = "source"
    note: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class Collector(ABC):
    """Base contract for all external infrastructure data collectors."""

    name: str

    @abstractmethod
    async def collect(self, station: str) -> list[CollectedObservation]:
        raise NotImplementedError
