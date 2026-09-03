from io import BytesIO
from xml.etree.ElementTree import iterparse

from app.identity import is_friedberg_hess


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def find_text(element, wanted: str) -> str | None:
    for child in element.iter():
        if local_name(child.tag) == wanted and child.text:
            return child.text.strip()
    return None


def find_friedberg_candidates(xml_bytes: bytes) -> list[dict]:
    """Stream a large NeTEx feed and return only Friedberg (Hess) candidates.

    This deliberately does not treat similarly named Friedberg stations as a
    match. Exact DB station-number mapping is added when the corresponding
    NeTEx key is verified in fixtures.
    """
    matches: list[dict] = []
    for _, elem in iterparse(BytesIO(xml_bytes), events=("end",)):
        kind = local_name(elem.tag)
        if kind in {"StopPlace", "Quay"}:
            name = find_text(elem, "Name")
            if name and is_friedberg_hess(name):
                matches.append({
                    "netex_type": kind,
                    "netex_id": elem.attrib.get("id"),
                    "name": name,
                })
            elem.clear()
    return matches
