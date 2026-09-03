FRIEDBERG_PROJECTS = [
    {
        "project_key": "FRI-ACCESSIBLE-STATION",
        "name": "Barrierefreier Ausbau Verkehrsstation Friedberg (Hess)",
        "status": "planning",
        "observations": [
            {
                "attribute": "design_planning_target",
                "value": "2026-11",
                "source_key": "friedberg-sessionnet-planning-agreement-2025",
                "quality_class": "A",
            },
            {
                "attribute": "crossing_agreement_target",
                "value": "2027-02",
                "source_key": "friedberg-sessionnet-planning-agreement-2025",
                "quality_class": "A",
            },
            {
                "attribute": "intended_construction_start",
                "value": "2028",
                "source_key": "friedberg-sessionnet-planning-agreement-2025",
                "quality_class": "A",
                "note": "Planning target, not an as-built fact.",
            },
        ],
    },
    {
        "project_key": "FRI-UNDERPASS-CITY-CONNECTION",
        "name": "Stadtteilverbindende Fuß- und Radwegeunterführung Bahnhof Friedberg",
        "status": "planning",
        "observations": [],
    },
    {
        "project_key": "FRI-S6-BAD-VILBEL-FRIEDBERG",
        "name": "S6-Ausbau Bad Vilbel–Friedberg",
        "status": "external_dependency",
        "observations": [],
    },
]

FRIEDBERG_PROJECT_SOURCES = [
    {
        "source_key": "friedberg-sessionnet-planning-agreement-2025",
        "publisher": "Stadt Friedberg (Hessen)",
        "source_type": "primary",
        "quality_class": "A",
        "url": "https://www.ratsinfo-friedberg-hessen.de/buergerinfo/vo0050.php?__kvonr=9520&voselect=4440",
    }
]
