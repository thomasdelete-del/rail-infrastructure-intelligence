from app.collectors.openstation import extract_friedberg_stop_places


def test_extracts_hessian_friedberg_only():
    xml = b'''<?xml version="1.0" encoding="UTF-8"?>
    <PublicationDelivery xmlns="http://www.netex.org.uk/netex">
      <StopPlace id="de:stop:1930"><Name>Friedberg (Hess)</Name><Centroid><Location><Longitude>8.75</Longitude><Latitude>50.33</Latitude></Location></Centroid></StopPlace>
      <StopPlace id="de:stop:bavaria"><Name>Friedberg (b Augsburg)</Name><Centroid><Location><Longitude>10.98</Longitude><Latitude>48.35</Latitude></Location></Centroid></StopPlace>
    </PublicationDelivery>'''
    result = extract_friedberg_stop_places(xml)
    assert len(result) == 1
    assert result[0]["netex_id"] == "de:stop:1930"
    assert result[0]["name"] == "Friedberg (Hess)"
    assert result[0]["latitude"] == 50.33
    assert result[0]["longitude"] == 8.75


def test_ambiguous_friedberg_is_rejected():
    xml = b'''<root><StopPlace id="x"><Name>Friedberg</Name></StopPlace></root>'''
    assert extract_friedberg_stop_places(xml) == []
