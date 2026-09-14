"""Resumable nationwide OSM geometry import, one bounded request at a time."""
import asyncio
import json
import logging
import httpx
from sqlalchemy import text
from app.database import get_engine
from app.services.osm_platforms import OVERPASS_ENDPOINTS, platform_query, _platform_elements, filter_rail_objects

logger = logging.getLogger(__name__)
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def next_station():
    with get_engine().connect() as connection:
        return connection.execute(text('''SELECT s.ril,s.latitude,s.longitude
            FROM station_location_snapshot s
            LEFT JOIN osm_platform_import_progress p ON p.ds100_rl100=s.ril
            LEFT JOIN osm_bahnsteig_cache c ON c.ds100_rl100=s.ril
            WHERE s.ril IS NOT NULL AND s.ril<>'' AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
              AND (c.updated_at IS NULL OR c.updated_at<now()-interval '30 days')
              AND (p.checked_at IS NULL OR
                   (p.status='failed' AND p.checked_at<now()-interval '1 hour') OR
                   (p.status='completed' AND p.checked_at<now()-interval '30 days'))
            ORDER BY p.checked_at NULLS FIRST,s.station_number LIMIT 1''')).first()


def store_result(ril, elements=None, error=None):
    with get_engine().begin() as connection:
        if elements is not None:
            connection.execute(text('''INSERT INTO osm_bahnsteig_cache(ds100_rl100,elements)
                VALUES(:ril,CAST(:payload AS JSONB)) ON CONFLICT(ds100_rl100)
                DO UPDATE SET elements=EXCLUDED.elements,updated_at=now()'''),
                {'ril':ril,'payload':json.dumps(elements)})
        connection.execute(text('''INSERT INTO osm_platform_import_progress(ds100_rl100,status,attempts,error)
            VALUES(:ril,:status,1,:error) ON CONFLICT(ds100_rl100) DO UPDATE SET
            status=EXCLUDED.status,attempts=osm_platform_import_progress.attempts+1,
            error=EXCLUDED.error,checked_at=now()'''),
            {'ril':ril,'status':'failed' if error else 'completed','error':error})


async def fetch_geometry(client, endpoint, latitude, longitude):
    data = bytearray()
    async with client.stream('GET',endpoint,params={'data':platform_query(latitude,longitude)}) as response:
        response.raise_for_status()
        async for chunk in response.aiter_bytes(chunk_size=65536):
            if len(data)+len(chunk)>MAX_RESPONSE_BYTES:
                raise ValueError('OSM response exceeds memory safety limit')
            data.extend(chunk)
    payload=json.loads(data)
    if 'elements' not in payload or not isinstance(payload['elements'],list) or payload.get('remark'):
        raise ValueError('Incomplete Overpass response')
    return _platform_elements(filter_rail_objects(payload['elements']))


async def run_osm_preload():
    endpoint_index=0
    async with httpx.AsyncClient(timeout=45,follow_redirects=True,
                               headers={'User-Agent':'rail-infrastructure-intelligence/2.0'}) as client:
        while True:
            try:
                station=next_station()
                if station is None:
                    await asyncio.sleep(60)
                    continue
                ril,latitude,longitude=station
                try:
                    elements=await fetch_geometry(client,OVERPASS_ENDPOINTS[endpoint_index % len(OVERPASS_ENDPOINTS)],latitude,longitude)
                    store_result(ril,elements=elements)
                    del elements
                except (httpx.HTTPError,ValueError) as error:
                    store_result(ril,error=f'{type(error).__name__}: {error}')
                endpoint_index+=1
                await asyncio.sleep(20)
            except Exception:
                logger.exception('OSM background import paused; will retry')
                await asyncio.sleep(60)


def import_status():
    with get_engine().connect() as connection:
        row=connection.execute(text('''SELECT
            COUNT(DISTINCT s.ril) AS eligible_stations,
            COUNT(DISTINCT s.ril) FILTER(WHERE c.ds100_rl100 IS NOT NULL) AS cached_stations,
            COUNT(DISTINCT s.ril) FILTER(WHERE c.ds100_rl100 IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(c.elements) e
                WHERE e->'tags'->>'railway' IN ('platform','platform_edge') OR
                (e->'tags'->>'public_transport'='platform' AND e->'tags'->>'train'='yes')
            )) AS empty_stations,
            COUNT(DISTINCT s.ril) FILTER(WHERE p.status='failed') AS failed_stations,
            MAX(c.updated_at) AS latest_snapshot
            FROM station_location_snapshot s
            LEFT JOIN osm_bahnsteig_cache c ON c.ds100_rl100=s.ril
            LEFT JOIN osm_platform_import_progress p ON p.ds100_rl100=s.ril
            WHERE s.ril IS NOT NULL AND s.ril<>'' AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL''')).mappings().one()
        return dict(row)
