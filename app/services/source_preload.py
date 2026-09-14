"""Bounded, persisted DB source enrichment, independent of viewer requests."""
import asyncio
import json
import tempfile
from xml.etree.ElementTree import iterparse

import httpx
from sqlalchemy import text
from app.database import get_engine
from app.collectors.openstation import local_name, station_identity, parse_stop_place, OpenStationCollector
from app.services.platform_data import DB_EQUIPMENT_INDEX, parse_equipment_index, parse_db_platform_table


def save_snapshot(source, key, payload):
    with get_engine().begin() as connection:
        connection.execute(text("""INSERT INTO station_source_snapshot(source,station_key,payload)
            VALUES(:source,:key,CAST(:payload AS JSONB)) ON CONFLICT(source,station_key)
            DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()"""),
            {"source": source, "key": str(key), "payload": json.dumps(payload, default=str)})


def set_status(source, status, error=None):
    with get_engine().begin() as connection:
        connection.execute(text("""INSERT INTO source_import_status(source,status,error)
            VALUES(:source,:status,:error) ON CONFLICT(source) DO UPDATE SET
            status=EXCLUDED.status,error=EXCLUDED.error,checked_at=now()"""),
            {"source": source, "status": status, "error": error})


def import_statistics():
    with get_engine().connect() as connection:
        return [dict(row) for row in connection.execute(text("""
            SELECT s.source,s.status,s.error,s.checked_at,
                   COUNT(p.station_key) AS stations,MAX(p.updated_at) AS latest_snapshot,
                   COALESCE(SUM(CASE WHEN s.source='db_equipment'
                       THEN jsonb_array_length(p.payload->'platforms') ELSE 0 END),0) AS platform_rows
            FROM source_import_status s LEFT JOIN station_source_snapshot p ON p.source=s.source
            GROUP BY s.source,s.status,s.error,s.checked_at ORDER BY s.source
        """)).mappings()]


def source_is_current(source):
    with get_engine().connect() as connection:
        return bool(connection.execute(text("""SELECT status='completed'
            AND checked_at > now()-interval '24 hours' FROM source_import_status WHERE source=:source"""),
            {"source": source}).scalar())


async def preload_netex(client):
    # Download to disk, never retain Germany's XML plus its DOM in RAM.
    with tempfile.TemporaryFile() as delivery:
        async with client.stream('GET', OpenStationCollector.netex_url) as response:
            response.raise_for_status()
            async for chunk in response.aiter_bytes():
                delivery.write(chunk)
        delivery.seek(0)
        context = iterparse(delivery, events=('start', 'end'))
        stack = []
        for event, element in context:
            if event == 'start':
                stack.append(element)
                continue
            if local_name(element.tag) == 'StopPlace':
                identity = station_identity(element)
                if identity:
                    record = parse_stop_place(element, expected_netex_id=identity['netex_id'])
                    save_snapshot('netex', identity.get('station_number') or identity['netex_id'],
                                  {'identity': identity, 'infrastructure': record})
                if len(stack) > 1:
                    stack[-2].remove(element)
                element.clear()
                await asyncio.sleep(0)
            elif not any(local_name(parent.tag) == 'StopPlace' for parent in stack):
                # Release unrelated frames too, not just station subtrees.
                if len(stack) > 1:
                    stack[-2].remove(element)
                element.clear()
            stack.pop()


async def preload_equipment(client):
    response = await client.get(DB_EQUIPMENT_INDEX)
    response.raise_for_status()
    pending = list(parse_equipment_index(response.text).items())
    if not pending:
        raise ValueError('Stationsausstattungs-Verzeichnis enthält keine erkennbaren Stationsseiten')
    for round_number in range(3):
        failed = []
        for name, url in pending:
            with get_engine().connect() as connection:
                current = connection.execute(text("""SELECT updated_at > now()-interval '24 hours'
                    FROM station_source_snapshot WHERE source='db_equipment' AND station_key=:key"""),
                    {"key": name}).scalar()
            if current:
                continue
            try:
                page = await client.get(url)
                page.raise_for_status()
                rows = parse_db_platform_table(page.text)
                save_snapshot('db_equipment', name, {'name': name, 'url': url, 'platforms': rows})
            except (httpx.HTTPError, ValueError):
                failed.append((name, url))
            await asyncio.sleep(2)
        pending = failed
        if not pending:
            return
        if round_number < 2:
            await asyncio.sleep(60)
    raise RuntimeError(f'{len(pending)} Stationsseiten weiterhin offen')


async def run_source_preload():
    async with httpx.AsyncClient(timeout=120, follow_redirects=True,
                               headers={'User-Agent': 'rail-infrastructure-intelligence/1.8'}) as client:
        for source, importer in (('netex', preload_netex), ('db_equipment', preload_equipment)):
            if source_is_current(source):
                continue
            set_status(source, 'running')
            try:
                await importer(client)
                set_status(source, 'completed')
            except Exception as error:
                set_status(source, 'failed', f'{type(error).__name__}: {error}')
