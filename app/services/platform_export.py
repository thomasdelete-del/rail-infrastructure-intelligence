"""Streaming CSV export of stored lengths, without live source requests."""
import csv
import io
from math import asin, cos, radians, sin, sqrt
from sqlalchemy import text
from app.database import get_engine

HEADER = ['Station', 'RIL100', 'Gleis', 'Quelle', 'Laengenart', 'Laenge_m', 'Objekt_ID', 'Datenstand']


def csv_line(values):
    output = io.StringIO()
    # Prevent spreadsheet formulas in externally supplied text.
    safe = ["'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v for v in values]
    csv.writer(output, delimiter=';', lineterminator='\r\n').writerow(safe)
    return output.getvalue()


def geometry_length(points):
    total = 0
    for a, b in zip(points, points[1:]):
        lat1, lon1, lat2, lon2 = map(radians, (a['lat'], a['lon'], b['lat'], b['lon']))
        h = sin((lat2-lat1)/2)**2 + cos(lat1)*cos(lat2)*sin((lon2-lon1)/2)**2
        total += 12742000 * asin(min(1, sqrt(h)))
    return total


def stored_rows(source):
    with get_engine().connect().execution_options(stream_results=True, yield_per=100) as connection:
        if source in ('all', 'isr'):
            rows = connection.execute(text('''SELECT bahnhofsname,ds100_rl100,
                COALESCE(NULLIF(isr_gleisnummer_verkehr,''),isr_gleisnummer_betrieb),
                isr_bahnsteignutzlaenge_m,isr_gleisnummer_betrieb,updated_at
                FROM bahnsteige WHERE isr_bahnsteignutzlaenge_m IS NOT NULL
                ORDER BY bahnhofsname,ds100_rl100,isr_gleisnummer_betrieb'''))
            for name, ril, track, length, object_id, timestamp in rows:
                yield [name,ril,track,'DB ISR','Bahnsteignutzlaenge',length,object_id,timestamp]
        if source in ('all', 'db'):
            rows = connection.execute(text('''SELECT p.payload->>'name',
                COALESCE(s.ril,''),r.value,p.updated_at,p.payload->>'url'
                FROM station_source_snapshot p
                CROSS JOIN LATERAL jsonb_array_elements(p.payload->'platforms') r(value)
                LEFT JOIN station_location_snapshot s ON
                    lower(regexp_replace(s.name,'\\s+',' ','g'))=p.station_key
                WHERE p.source='db_equipment' ORDER BY p.station_key'''))
            for name, ril, record, timestamp, url in rows:
                length = record.get('net_construction_length_m')
                if length is not None:
                    yield [name,ril,record.get('track',''),'DB InfraGO Stationsausstattung','Nettobaulaenge',length,url,timestamp]
        if source in ('all', 'osm'):
            rows = connection.execute(text('''SELECT COALESCE(b.bahnhofsname,s.name,c.ds100_rl100),
                c.ds100_rl100,e.value,c.updated_at FROM osm_bahnsteig_cache c
                CROSS JOIN LATERAL jsonb_array_elements(c.elements) e(value)
                LEFT JOIN betriebsstelle b ON b.ds100_rl100=c.ds100_rl100
                LEFT JOIN station_location_snapshot s ON s.ril=c.ds100_rl100
                ORDER BY c.ds100_rl100'''))
            for name, ril, element, timestamp in rows:
                tags = element.get('tags') or {}
                points = element.get('geometry') or []
                # Areas are not individual platform edges; never export their perimeter as length.
                if element.get('type') != 'way' or len(points)<2 or points[0]==points[-1] or tags.get('area')=='yes':
                    continue
                if tags.get('railway') not in ('platform','platform_edge') and not (tags.get('public_transport')=='platform' and tags.get('train')=='yes'):
                    continue
                yield [name,ril,tags.get('local_ref') or tags.get('ref') or '', 'OpenStreetMap',
                       'OSM_Baulaenge_Originalgeometrie',geometry_length(points),f"way/{element['id']}",timestamp]


def export_csv(station='', ril='', track='', source='all', minimum=None, maximum=None):
    yield '\ufeff' + csv_line(HEADER)
    for row in stored_rows(source):
        length = float(row[5])
        if station.casefold() not in str(row[0]).casefold(): continue
        if ril and ril.casefold() != str(row[1]).casefold(): continue
        if track and track.casefold() != str(row[2]).casefold(): continue
        if minimum is not None and length < minimum: continue
        if maximum is not None and length > maximum: continue
        row[5] = f'{length:.1f}'.replace('.', ',')
        yield csv_line(row)
