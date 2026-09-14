"""Streaming CSV export of stored lengths, without live source requests."""
import csv
import io
import json
import sqlite3
import tempfile
from math import asin, cos, radians, sin, sqrt
from sqlalchemy import text
from app.database import get_engine

HEADER = ['Station', 'RIL100', 'Gleis', 'OSM_Baulaenge_m', 'DB_Nettobaulaenge_m', 'ISR_Nutzlaenge_m',
          'OSM_Objekt_ID', 'DB_Quelle', 'ISR_Objekt_ID', 'OSM_Datenstand', 'DB_Datenstand', 'ISR_Datenstand']
HEADER += ['Anfang_Breitengrad_WGS84', 'Anfang_Laengengrad_WGS84',
           'Ende_Breitengrad_WGS84', 'Ende_Laengengrad_WGS84', 'Zuordnungshinweis']


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
                       'OSM_Baulaenge_Originalgeometrie',geometry_length(points),f"way/{element['id']}",timestamp,
                       points[0]['lat'],points[0]['lon'],points[-1]['lat'],points[-1]['lon']]


def export_csv(station='', ril='', track='', source='all', minimum=None, maximum=None):
    yield '\ufeff' + csv_line(HEADER)
    # Disk-backed grouping keeps nationwide exports bounded in RAM.
    with tempfile.TemporaryDirectory(prefix='platform-export-') as directory:
        connection = sqlite3.connect(directory + '/rows.sqlite')
        try:
            connection.execute('CREATE TABLE records (station_key TEXT, track TEXT, source TEXT, object_id TEXT, payload TEXT, PRIMARY KEY(station_key,track,source,object_id))')
            for row in stored_rows('all'):
                if station.casefold() not in str(row[0]).casefold(): continue
                if ril and ril.casefold() != str(row[1]).casefold(): continue
                if track and track.casefold() != str(row[2]).casefold(): continue
                # Without RIL100, do not guess that similarly named stations are identical.
                key = str(row[1]).upper() if row[1] else 'unresolved:' + row[3] + ':' + str(row[0])
                track_key = str(row[2]).casefold().strip() or 'unassigned:' + str(row[6])
                connection.execute('INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)',
                    (key,track_key,row[3],str(row[6]),json.dumps(row,default=str)))
            connection.commit()
            groups = connection.execute('SELECT DISTINCT station_key,track FROM records ORDER BY station_key,track')
            for station_key, track_key in groups:
                records = [json.loads(payload) for (payload,) in connection.execute(
                    'SELECT payload FROM records WHERE station_key=? AND track=? ORDER BY source,object_id', (station_key,track_key))]
                candidates = {name:[row for row in records if row[3]==name] for name in
                    ('OpenStreetMap','DB InfraGO Stationsausstattung','DB ISR')}
                required = {'osm':'OpenStreetMap','db':'DB InfraGO Stationsausstattung','isr':'DB ISR'}.get(source)
                selected = candidates[required] if required else records
                if not selected: continue
                if minimum is not None or maximum is not None:
                    if not any((minimum is None or float(row[5])>=minimum) and
                               (maximum is None or float(row[5])<=maximum) for row in selected): continue
                osm,db,isr = [rows[0] if len(rows)==1 else None for rows in candidates.values()]
                primary = isr or db or osm or records[0]
                notes = [f'{name}: {len(rows)} Kandidaten, Länge nicht eindeutig' for name,rows in candidates.items() if len(rows)>1]
                if not primary[1]: notes.append('Stationsidentität nicht zugeordnet; Quellen nicht zusammengeführt')
                if not primary[2]: notes.append('Gleis nicht zugeordnet')
                def length(row):
                    return f'{float(row[5]):.1f}'.replace('.', ',') if row else ''
                def field(row,index):
                    return row[index] if row else ''
                coordinates = osm[8:12] if osm and len(osm)>=12 else ['']*4
                coordinates = [f'{float(value):.6f}'.replace('.', ',') if value is not None and value!='' else '' for value in coordinates]
                yield csv_line([primary[0],primary[1],primary[2],length(osm),length(db),length(isr),
                    ' | '.join(str(row[6]) for row in candidates['OpenStreetMap']),
                    ' | '.join(str(row[6]) for row in candidates['DB InfraGO Stationsausstattung']),
                    ' | '.join(str(row[6]) for row in candidates['DB ISR']),
                    field(osm,7),field(db,7),field(isr,7),*coordinates,'; '.join(notes)])
        finally:
            connection.close()
