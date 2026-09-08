from decimal import Decimal

from app.services.platform_matching import _csv_rows, _hash, merge_platforms, rinf_uopid


def test_rinf_uopid_padding_formula():
    assert rinf_uopid("FBBH") == "DE0FBBH"
    assert rinf_uopid("HH") == "DE000HH"
    assert rinf_uopid("FBB") == "DE00FBB"


def test_csv_parser_accepts_semicolon_and_decimal_comma():
    rows = _csv_rows("STEL_ID;BST_RL100;BST_STELLE_NAME\n1;FBB;Bruchenbrücken\n")
    assert rows[0]["BST_RL100"] == "FBB"


def test_merge_uses_isr_length_and_exact_rinf_platform_match():
    station = {"BST_RL100": "FBB", "BST_STELLE_NAME": "Bruchenbrücken", "STRNR": "3900"}
    isr = [{
        "GLEISNUMMER__BETRIEB": "1", "GLEISNUMMER__VERKEHR": "1",
        "SYSTEMHÖHE_IN_CM": "76", "MAX__BAHNSTEIGNUTZLAENGEN_IN_M": "140.5",
    }]
    rinf = [{"platformId": "1", "trackId": "track-1"}]
    row = merge_platforms(station, isr, rinf, "8000001")[0]
    assert row["isr_bahnsteignutzlaenge_m"] == Decimal("140.5")
    assert row["rinf_platform_id"] == "1"
    assert row["match_methode"] == "ISR+RINF eindeutig"
    assert row["osm_bahnsteig_ref"] is None


def test_merge_marks_directional_prefix_matches_ambiguous_without_duplicate_db_rows():
    station = {"BST_RL100": "UN", "BST_STELLE_NAME": "Unna", "STRNR": "2932"}
    isr = [{"GLEISNUMMER__BETRIEB": "20", "GLEISNUMMER__VERKEHR": "20"}]
    rinf = [
        {"platformId": "20-N20", "trackId": "north"},
        {"platformId": "20-P20", "trackId": "south"},
    ]
    rows = merge_platforms(station, isr, rinf, None)
    assert len(rows) == 1
    assert rows[0]["match_methode"] == "ISR+RINF mehrdeutig"
    assert rows[0]["rinf_platform_id"] == "20-N20 | 20-P20"


def test_source_hash_is_stable_and_ignores_sync_timestamps():
    row = {"ds100_rl100": "FBB", "isr_gleisnummer_betrieb": "1"}
    assert _hash({**row, "last_checked_at": "old"}) == _hash({**row, "last_checked_at": "new"})
