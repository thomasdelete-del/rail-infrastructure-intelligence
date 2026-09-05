SOURCE = {
    "id": "db-infrago-station-equipment-friedberg-2026-08-17",
    "publisher": "DB InfraGO AG",
    "source_type": "primary",
    "quality_class": "A",
    "source_date": "2026-08-17",
    "url": "https://www.dbinfrago.com/web/bahnhoefe/leistungen/stationsnutzung/stationshalt/stationsausstattung/Friedberg-Hess--12673926",
}


def edge(track, height_mm, length_m, accessible, tactile, access_method=None):
    observations = [
        {"attribute": "platform_height", "value": height_mm, "unit": "mm", "source_id": SOURCE["id"]},
        {"attribute": "net_construction_length", "value": length_m, "unit": "m", "source_id": SOURCE["id"], "note": "DB warns this value is not suitable as train usable length."},
        {"attribute": "step_free", "value": accessible, "unit": None, "source_id": SOURCE["id"]},
        {"attribute": "tactile_strip", "value": tactile, "unit": None, "source_id": SOURCE["id"]},
    ]
    if access_method:
        observations.append({"attribute": "step_free_access_method", "value": access_method, "unit": None, "source_id": SOURCE["id"]})
    return {"object_id": f"FRI-PE-{track.upper().replace(' ', '-')}", "object_type": "platform_edge", "track": track, "observations": observations}


FRIEDBERG = {
    "station_id": "DE-FRI-HESS-1930",
    "name": "Friedberg (Hess)",
    "station_number": 1930,
    "address": "Hanauer Str. 44, 61169 Friedberg (Hessen)",
    "state": "existing",
    "data_state": "2026-08-17",
    "sources": [SOURCE],
    "platform_edges": [
        edge("1", 760, 280, True, True, "level_access"),
        edge("2", 760, 354, False, True),
        edge("4", 760, 354, False, True),
        edge("5", 760, 276, False, False),
        edge("7", 760, 280, False, False),
        edge("8", 550, 265, False, True),
        edge("10", 550, 265, False, True),
        edge("11", 380, 184, False, False),
        edge("12", 380, 184, False, False),
        edge("1a", 760, 137, True, True, "level_access"),
    ],
    "projects": [], "geometries": [], "conflicts": [],
    "data_gaps": [
        "Authoritative operational platform usable lengths",
        "Platform and roof geometries", "Current detailed track topology",
        "Elevator/stair/underpass object inventory and geometry",
        "Current and planned overhead-line geometry",
        "Current plan-approval documents and object-level target state",
        "Parcel boundaries and ownership-relevant planning information",
        "DGM/DOM/orthophoto-derived station terrain model",
    ],
}
