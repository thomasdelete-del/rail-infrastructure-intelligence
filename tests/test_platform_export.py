import csv
import io
from app.services import platform_export as export

def test_filters_and_safe_csv(monkeypatch):
    monkeypatch.setattr(export,'stored_rows',lambda source: iter([
        ['Achern','RAH','1','DB ISR','Bahnsteignutzlaenge',370,'501','2026-09-14'],
        ['=Formula','X','2','DB ISR','Bahnsteignutzlaenge',200,'502','2026-09-14']]))
    result=''.join(export.export_csv(station='ach',track='1',minimum=300,maximum=400))
    rows=list(csv.reader(io.StringIO(result.lstrip('\ufeff')),delimiter=';'))
    assert len(rows)==2 and rows[1][5]=='370,0'
    assert len(rows[1]) == len(export.HEADER) == 17
    assert rows[1][12:16] == ['', '', '', '']
    assert export.csv_line(['=1+1']).startswith("'=1+1")

def test_geometry_length():
    assert 111 < export.geometry_length([{'lat':0,'lon':0},{'lat':0,'lon':0.001}]) < 112

def test_endpoint_coordinates_are_exported_in_wgs84(monkeypatch):
    monkeypatch.setattr(export,'stored_rows',lambda source: iter([
        ['Test','T','1','OpenStreetMap','OSM_Baulaenge_Originalgeometrie',111,'way/1','2026-09-15',
         50.1234567,8.1234567,50.1244567,8.1244567]]))
    rows=list(csv.reader(io.StringIO(''.join(export.export_csv()).lstrip('\ufeff')),delimiter=';'))
    assert rows[1][12:16] == ['50,123457','8,123457','50,124457','8,124457']

def test_sources_are_side_by_side_and_ambiguity_is_not_guessed(monkeypatch):
    records=[['Test','T','1','DB ISR','Nutzlaenge',195,'isr/1','now'],
             ['test','T','1','DB InfraGO Stationsausstattung','Nettobaulaenge',200,'db/1','now'],
             ['Test','T','1','OpenStreetMap','Baulaenge',210,'way/1','now']]
    monkeypatch.setattr(export,'stored_rows',lambda source:iter(records))
    rows=list(csv.reader(io.StringIO(''.join(export.export_csv()).lstrip('\ufeff')),delimiter=';'))
    assert len(rows)==2 and rows[1][3:6]==['210,0','200,0','195,0']
    records.append(['Test','T','1','OpenStreetMap','Baulaenge',220,'way/2','now'])
    rows=list(csv.reader(io.StringIO(''.join(export.export_csv()).lstrip('\ufeff')),delimiter=';'))
    assert rows[1][3]=='' and '2 Kandidaten' in rows[1][16]
