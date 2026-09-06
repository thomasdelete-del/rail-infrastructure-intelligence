from app.services.platform_data import parse_db_platform_table, parse_equipment_index, parse_rinf_lengths


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


def test_parses_rinf_usable_lengths():
    data = {"results": {"bindings": [{
        "uopid": {"value": "DE0FBEI"}, "platformId": {"value": "1"},
        "length": {"value": "112"}, "platform": {"value": "https://example.test/platform/1"},
    }]}}
    assert parse_rinf_lengths(data)[0]["usable_length_m"] == 112.0
