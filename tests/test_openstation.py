import asyncio
import pytest

from app.collectors.openstation import OpenStationCollector, extract_friedberg_stop_places, select_station_identity_from_netex

XML = b'''<PublicationDelivery xmlns="http://www.netex.org.uk/netex"><StopPlace id="sp-hess">
<keyList><KeyValue><Key>EVA</Key><Value>8000111</Value></KeyValue><KeyValue><Key>RIL</Key><Value>FFG</Value></KeyValue></keyList>
<Name>Friedberg (Hess)</Name><PrivateCode>1930</PrivateCode>
<Centroid><Location><Latitude>50.33</Latitude><Longitude>8.75</Longitude></Location></Centroid>
<AccessibilityAssessment><MobilityImpairedAccess>partial</MobilityImpairedAccess><limitations><AccessibilityLimitation><StepFreeAccess>partial</StepFreeAccess></AccessibilityLimitation></limitations></AccessibilityAssessment>
<quays><Quay id="platform-1"><Name>Bahnsteig Gleis 1/2</Name><QuayType>railIslandPlatform</QuayType></Quay><Quay id="platform-1:edge-1"><Name>1</Name><PublicCode>1</PublicCode><QuayType>railPlatform</QuayType><Centroid><Location><Latitude>50.331</Latitude><Longitude>8.751</Longitude></Location></Centroid></Quay></quays>
<entrances><Entrance id="entrance-1"><Name>Vorplatz</Name><IsExternal>true</IsExternal><IsEntry>true</IsEntry><IsExit>true</IsExit></Entrance></entrances>
<placeEquipments><LiftEquipment id="lift-1"><Name>Aufzug Gleis 1</Name><OutOfService>false</OutOfService><Width>1.1</Width></LiftEquipment><StaircaseEquipment id="stairs-1"><Name>Treppe Gleis 1</Name><NumberOfSteps>24</NumberOfSteps><SafeForGuideDog>true</SafeForGuideDog></StaircaseEquipment></placeEquipments>
</StopPlace></PublicationDelivery>'''


def test_extracts_source_values_as_separate_entities():
    entities = {item["netex_id"]: item for item in extract_friedberg_stop_places(XML)[0]["entities"]}
    assert entities["sp-hess"]["attributes"]["latitude"] == 50.33
    assert entities["sp-hess"]["attributes"]["step_free_access"] == "partial"
    assert entities["platform-1"]["object_type"] == "platform"
    assert entities["platform-1:edge-1"]["object_type"] == "platform_edge"
    assert entities["platform-1:edge-1"]["parent_netex_id"] == "platform-1"
    assert entities["platform-1:edge-1"]["attributes"]["public_code"] == 1
    assert entities["entrance-1"]["attributes"]["is_entry"] is True
    assert entities["lift-1"]["attributes"] == {"name": "Aufzug Gleis 1", "equipment_type": "LiftEquipment", "out_of_service": False, "width": 1.1}
    assert entities["stairs-1"]["attributes"]["number_of_steps"] == 24


def test_collector_creates_separate_observations_with_provenance():
    collector = OpenStationCollector()
    async def fixture(): return XML
    collector.fetch_netex = fixture
    observations = asyncio.run(collector.collect("Friedberg (Hess)"))
    item = next(o for o in observations if o.object_key == "FRI-PE-1" and o.attribute == "latitude")
    assert (item.value, item.unit) == (50.331, "degree")
    assert item.metadata == {"netex_id": "platform-1:edge-1", "netex_type": "Quay", "parent_netex_id": "platform-1", "station_netex_id": "sp-hess"}


def test_missing_optional_infrastructure_is_not_invented():
    xml = XML.replace(b'<LiftEquipment id="lift-1"><Name>Aufzug Gleis 1</Name><OutOfService>false</OutOfService><Width>1.1</Width></LiftEquipment>', b'')
    entities = extract_friedberg_stop_places(xml)[0]["entities"]
    assert all(entity["netex_type"] != "LiftEquipment" for entity in entities)


def test_ambiguous_or_wrong_friedberg_is_rejected():
    ambiguous = b'<root><StopPlace id="x"><Name>Friedberg</Name><PrivateCode>1930</PrivateCode></StopPlace></root>'
    bavaria = XML.replace(b"1930", b"1867")
    wrong_eva = XML.replace(b"8000111", b"8002071")
    assert extract_friedberg_stop_places(ambiguous) == []
    assert extract_friedberg_stop_places(bavaria) == []
    assert extract_friedberg_stop_places(wrong_eva) == []


def test_resolves_generic_station_identifiers_from_netex():
    identity = select_station_identity_from_netex(XML, "Friedberg Hess", 50.3301, 8.7501)
    assert identity["station_number"] == 1930
    assert identity["eva"] == "8000111"
    assert identity["ril"] == "FFG"
    assert identity["netex_id"] == "sp-hess"
    assert identity["identity_status"] == "identified"


def test_rejects_similar_station_name_when_netex_coordinates_are_missing():
    xml = b'<root><StopPlace id="norheim"><Name>Norheim</Name><PrivateCode>4584</PrivateCode></StopPlace></root>'
    with pytest.raises(LookupError):
        select_station_identity_from_netex(xml, "Dorheim", 50.35, 8.79)
