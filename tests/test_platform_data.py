from app.services.platform_data import map_rinf_platforms, parse_db_platform_table, parse_equipment_index, parse_rinf_lengths


def test_parses_db_platform_dimensions_from_compact_table():
    html = '''Gleisnummer | Bahnsteighöhe | Nettobaulänge |</th></tr></thead><tbody><tr><td><p>
1 | 18 cm | 123 m | ja | höhengleich<br>2 | 18 cm | 153 m | ja | höhengleich
</p></td></tr></tbody>'''
    assert parse_db_platform_table(html) == [
        {"track": "1", "platform_height_mm": 180, "net_construction_length_m": 123.0},
        {"track": "2", "platform_height_mm": 180, "net_construction_length_m": 153.0},
    ]


def test_parses_station_equipment_index():
    html = '<a href="/web/x/stationsausstattung/Beienheim-12670896?view="><div><h3 class="title">Beienheim<span>.</span></h3></div></a>'
    assert parse_equipment_index(html)["beienheim"].endswith("/Beienheim-12670896")


def test_index_preserves_compound_db_station_name_for_unique_suffix_matching():
    html = '<a href="/web/x/stationsausstattung/Rotenburg-an-der-Fulda-Lispenhausen-12673986"><h3>Rotenburg an der Fulda-Lispenhausen</h3></a>'
    links = parse_equipment_index(html)
    assert "rotenburg an der fulda-lispenhausen" in links


def test_parses_rinf_usable_lengths():
    data = {"results": {"bindings": [{
        "uopid": {"value": "DE0FBEI"}, "platformId": {"value": "1"},
        "length": {"value": "112"}, "platform": {"value": "https://example.test/platform/1"},
    }]}}
    assert parse_rinf_lengths(data)[0]["usable_length_m"] == 112.0


def test_rinf_plus_collapses_directional_tracks_with_same_platform_id():
    def binding(track_id: str):
        return {
            "uopid": {"value": "DE0FBEI"},
            "platformId": {"value": "1"},
            "trackId": {"value": track_id},
            "length": {"value": "112"},
            "platform": {"value": "https://example.test/platform/1"},
        }

    rows = parse_rinf_lengths({"results": {"bindings": [binding("1_A"), binding("1_B")]}})

    assert len(rows) == 1
    assert rows[0]["platform_id"] == "1"
    assert rows[0]["directional_track_ids"] == ["1_A", "1_B"]


def test_maps_bruchenbruecken_crosswalk_and_unique_remainder():
    db = [{"track": "1"}, {"track": "2"}]
    rinf = [
        {"platform_id": "293", "track_id": "293_113300", "usable_length_m": 210},
        {"platform_id": "538", "track_id": "538_113301", "usable_length_m": 210},
    ]
    mapped, used = map_rinf_platforms(db, rinf, "FBB")
    assert mapped["1"]["platform_id"] == "293"
    assert mapped["1"]["mapping_method"] == "station_crosswalk"
    assert mapped["2"]["platform_id"] == "538"
    assert mapped["2"]["mapping_method"] == "bijective_remainder"
    assert mapped["1"]["mapping_score"] == 100
    assert mapped["2"]["mapping_score"] == 80
    assert used == {"293", "538"}


def test_maps_lispenhausen_platform_962_to_public_track_1():
    db = [{"track": "1"}, {"track": "2"}]
    rinf = [
        {"platform_id": "962", "track_id": "962_125263", "usable_length_m": 174},
        {"platform_id": "970", "track_id": "970_125262", "usable_length_m": 135},
    ]
    mapped, used = map_rinf_platforms(db, rinf, "FLIH")
    assert mapped["1"]["platform_id"] == "962"
    assert mapped["1"]["mapping_method"] == "station_crosswalk"
    assert mapped["1"]["mapping_score"] == 100
    assert mapped["2"]["platform_id"] == "970"
    assert mapped["2"]["mapping_method"] == "bijective_remainder"
    assert used == {"962", "970"}


def test_restores_friedberg_pilot_platform_length_crosswalk():
    tracks = ["1", "1a", "2", "4", "5", "7", "8", "10", "11", "12"]
    db = [{"track": track} for track in tracks]
    rinf = [
        {
            "platform_id": track,
            "track_id": f"{track}_direction_a",
            "directional_track_ids": [
                f"{track}_direction_a",
                f"{track}_direction_b",
            ],
            "usable_length_m": 100 + index,
        }
        for index, track in enumerate(tracks)
    ]

    mapped, used = map_rinf_platforms(db, rinf, "FFG")

    assert used == set(tracks)
    assert all(mapped[track]["platform_id"] == track for track in tracks)
    assert all(mapped[track]["mapping_method"] == "station_crosswalk" for track in tracks)
    assert all(mapped[track]["mapping_score"] == 100 for track in tracks)


def test_maps_unique_rinf_directional_track_identifier_to_db_track():
    db = [{"track": "4"}, {"track": "7"}]
    rinf = [
        {"platform_id": "P-A", "directional_track_ids": ["direction_4_A", "direction_4_B"], "usable_length_m": 210},
        {"platform_id": "P-B", "directional_track_ids": ["direction_7_A", "direction_7_B"], "usable_length_m": 190},
    ]

    mapped, used = map_rinf_platforms(db, rinf, "TEST")

    assert mapped["4"]["platform_id"] == "P-A"
    assert mapped["4"]["mapping_method"] == "exact_rinf_track_id"
    assert mapped["7"]["platform_id"] == "P-B"
    assert used == {"P-A", "P-B"}


def test_line_number_mapping_requires_unique_candidate():
    db = [{"track": "1", "line_number": "3900"}]
    rinf = [
        {"platform_id": "A", "line_number": "3900", "usable_length_m": 200},
    ]

    mapped, used = map_rinf_platforms(db, rinf, "TEST")

    assert mapped["1"]["platform_id"] == "A"
    assert mapped["1"]["mapping_method"] == "unique_line_number"
    assert used == {"A"}
