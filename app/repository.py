import json
from typing import Any

from sqlalchemy import text

from app.database import get_engine


def load_observations(source_key: str) -> list[dict[str, Any]]:
    sql = text('''
        SELECT io.object_key, o.attribute, o.value_json, o.unit, s.source_key
        FROM observation o
        JOIN infrastructure_object io ON io.id = o.object_id
        JOIN source s ON s.id = o.source_id
        WHERE s.source_key = :source_key
        ORDER BY o.observed_at NULLS LAST, o.id
    ''')
    with get_engine().connect() as connection:
        rows = connection.execute(sql, {"source_key": source_key}).mappings()
        return [
            {"object_key": row["object_key"], "attribute": row["attribute"], "value": row["value_json"], "unit": row["unit"], "source_key": row["source_key"]}
            for row in rows
        ]


def store_observations(items: list[dict[str, Any]]) -> int:
    """Append evidence. Existing observations are never updated in place."""
    if not items:
        return 0
    with get_engine().begin() as connection:
        for item in items:
            source_id = connection.execute(text('''
                INSERT INTO source (source_key, publisher, url, source_type, quality_class)
                VALUES (:key, 'DB InfraGO AG', :url, 'primary', :quality)
                ON CONFLICT (source_key) DO UPDATE SET url = EXCLUDED.url
                RETURNING id
            '''), {"key": item["source_key"], "url": item.get("source_url"), "quality": item.get("quality_class", "A")}).scalar_one()
            object_id = connection.execute(text('''
                INSERT INTO infrastructure_object (object_key, object_type)
                VALUES (:key, :type)
                ON CONFLICT (object_key) DO UPDATE SET object_type = EXCLUDED.object_type
                RETURNING id
            '''), {"key": item["object_key"], "type": item["object_type"]}).scalar_one()
            connection.execute(text('''
                INSERT INTO observation (object_id, attribute, value_json, unit, source_id, observed_at, method, is_derived, note)
                VALUES (:object_id, :attribute, CAST(:value AS jsonb), :unit, :source_id, now(), :method, :derived, :note)
            '''), {
                "object_id": object_id, "attribute": item["attribute"], "value": json.dumps(item["value"]),
                "unit": item.get("unit"), "source_id": source_id, "method": item.get("method", "source"),
                "derived": item.get("is_derived", False), "note": item.get("note"),
            })
    return len(items)
