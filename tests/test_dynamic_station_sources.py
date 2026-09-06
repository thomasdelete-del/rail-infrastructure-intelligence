from app.services.dynamic_station_sources import normalize_fasta, normalize_stada


def test_normalize_stada_selects_requested_station():
    data = {"result": [{"number": 1, "name": "Wrong"}, {"number": 22, "name": "Right", "category": 5}]}
    assert normalize_stada(data, "22") == {"number": 22, "name": "Right", "category": 5}
    assert normalize_stada(data, 22) == {"number": 22, "name": "Right", "category": 5}


def test_normalize_fasta_filters_station():
    data = {"facilities": [{"stationnumber": 22, "equipmentnumber": 7, "type": "ELEVATOR", "state": "ACTIVE"}, {"stationnumber": 1, "equipmentnumber": 8}]}
    assert normalize_fasta(data, "22") == [{"equipmentnumber": 7, "type": "ELEVATOR", "state": "ACTIVE", "description": None, "geocoordX": None, "geocoordY": None}]
