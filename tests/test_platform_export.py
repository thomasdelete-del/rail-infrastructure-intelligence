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
    assert export.csv_line(['=1+1']).startswith("'=1+1")

def test_geometry_length():
    assert 111 < export.geometry_length([{'lat':0,'lon':0},{'lat':0,'lon':0.001}]) < 112
