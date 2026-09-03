SOURCE_2026 = {
    "source_key": "db-infrago-service-tracks-2026-04-01",
    "publisher": "DB InfraGO AG",
    "title": "Gleise in Serviceeinrichtungen 2026",
    "source_type": "primary",
    "quality_class": "A",
    "source_date": "2026-04-01",
    "page": 34,
    "url": "https://www.dbinfrago.com/resource/blob/10907624/d052cae0c9cb427437de6346d678b2fa/gleise_in_serviceeinrichtungen_2026-data.pdf",
}

# Values are transcribed as published. Suspicious source values are retained,
# never silently corrected (e.g. track 55 overhead-line length 730 m vs 120 m track length).
ROWS = [
    ("27", 774, 0, 0, None), ("28", 761, 0, 0, None),
    ("31", 254, 0, 0, None), ("39", 310, 0, 0, None),
    ("40", 244, 0, 0, None), ("41", 282, 0, 0, None),
    ("50", 160, 171, 0, "TA (1)"), ("55", 120, 730, 0, None),
    ("64", 210, 333, 0, None), ("69", 330, 403, 0, None),
    ("77", 323, 0, 0, None), ("85", 300, 0, 3, None),
    ("101", 212, 0, 163, None), ("102", 100, 0, 0, None),
    ("110", 75, 88, 0, None), ("212", 177, 0, 0, "ELEK (2); TA (1)"),
    ("312", 156, 0, 0, "TA (1)"), ("355", 210, 246, 0, None),
]

FRIEDBERG_SERVICE_TRACKS = [
    {
        "object_id": f"FRI-SERVICE-TRACK-{track}",
        "object_type": "service_track",
        "track": track,
        "usable_length_m": usable,
        "overhead_line_length_m": ohl,
        "loading_edge_length_m": loading,
        "additional_equipment": equipment,
        "source_key": SOURCE_2026["source_key"],
        "quality_class": "F" if ohl > usable and ohl > 0 else "A",
        "source_value_preserved": True,
    }
    for track, usable, ohl, loading, equipment in ROWS
]

FRIEDBERG_SERVICE_TRACK_CONFLICTS = [
    {
        "object_id": "FRI-SERVICE-TRACK-55",
        "attribute": "overhead_line_length_m",
        "status": "needs_verification",
        "reason": "Published overhead-line length exceeds published usable track length; source value retained unchanged.",
        "published_value": 730,
        "usable_length_m": 120,
        "source_key": SOURCE_2026["source_key"],
    }
]
