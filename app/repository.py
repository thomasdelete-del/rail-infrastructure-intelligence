import json
import re
from collections import Counter, defaultdict
from typing import Any

from sqlalchemy import text

from app.database import get_engine


def load_observations(source_key: str | None = None) -> list[dict[str, Any]]:
    source_filter = "" if source_key is None else "WHERE s.source_key = :source_key"
    sql = text(f'''
        SELECT io.object_key, io.object_type, o.attribute, o.value_json, o.unit,
               s.source_key, s.url AS source_url, s.quality_class,
               o.method, o.is_derived, o.note, o.provenance
        FROM observation o
        JOIN infrastructure_object io ON io.id = o.object_id
        JOIN source s ON s.id = o.source_id
        {source_filter}
        ORDER BY o.observed_at NULLS LAST, o.id
    ''')
    with get_engine().connect() as connection:
        parameters = {"source_key": source_key} if source_key is not None else {}
        rows = connection.execute(sql, parameters).mappings()
        return [
            {
                "object_key": row["object_key"], "object_type": row["object_type"],
                "attribute": row["attribute"], "value": row["value_json"],
                "unit": row["unit"], "source_key": row["source_key"],
                "source_url": row["source_url"], "quality_class": row["quality_class"],
                "method": row["method"], "is_derived": row["is_derived"],
                "note": row["note"], "metadata": row["provenance"] or {},
            }
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
                VALUES (:key, :publisher, :url, :source_type, :quality)
                ON CONFLICT (source_key) DO UPDATE SET source_key = EXCLUDED.source_key
                RETURNING id
            '''), {"key": item["source_key"], "publisher": item.get("source_publisher", "Unknown"),
                   "url": item.get("source_url"), "source_type": item.get("source_type", "external"),
                   "quality": item.get("quality_class", "F")}).scalar_one()
            object_id = connection.execute(text('''
                INSERT INTO infrastructure_object (object_key, object_type)
                VALUES (:key, :type)
                ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key
                RETURNING id
            '''), {"key": item["object_key"], "type": item["object_type"]}).scalar_one()
            connection.execute(text('''
                INSERT INTO observation (object_id, attribute, value_json, unit, source_id, observed_at, method, is_derived, note, provenance)
                VALUES (:object_id, :attribute, CAST(:value AS jsonb), :unit, :source_id, now(), :method, :derived, :note, CAST(:provenance AS jsonb))
            '''), {
                "object_id": object_id, "attribute": item["attribute"], "value": json.dumps(item["value"]),
                "unit": item.get("unit"), "source_id": source_id, "method": item.get("method", "source"),
                "derived": item.get("is_derived", False), "note": item.get("note"),
                "provenance": json.dumps(item.get("metadata", {})),
            })
            parent_key = item.get("metadata", {}).get("parent_object_key")
            if parent_key:
                parent_id = connection.execute(text(
                    "SELECT id FROM infrastructure_object WHERE object_key = :key"
                ), {"key": parent_key}).scalar_one_or_none()
                if parent_id:
                    connection.execute(text('''
                        INSERT INTO object_relation (subject_id, predicate, object_id, source_id)
                        SELECT :child, 'part_of', :parent, :source
                        WHERE NOT EXISTS (
                            SELECT 1 FROM object_relation
                            WHERE subject_id = :child AND predicate = 'part_of'
                              AND object_id = :parent AND source_id = :source
                        )
                    '''), {"child": object_id, "parent": parent_id, "source": source_id})
    return len(items)


def build_infrastructure_inventory(rows: list[dict[str, Any]], station: str) -> dict[str, Any]:
    objects: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = objects.setdefault(row["object_key"], {
            "object_key": row["object_key"],
            "object_type": row["object_type"],
            "parent_object_key": row.get("parent_object_key"),
            "depth": row["depth"],
            "observations": [],
        })
        if row.get("attribute") is not None:
            item["observations"].append({
                "attribute": row["attribute"], "value": row["value"], "unit": row.get("unit"),
                "source_key": row["source_key"], "observed_at": row.get("observed_at"),
                "provenance": row.get("provenance") or {},
            })
    ordered = sorted(objects.values(), key=lambda item: (item["depth"], item["object_type"], item["object_key"]))
    return {"station": station, "object_count": len(ordered), "objects": ordered}


def load_infrastructure_inventory(root_object_key: str, station: str) -> dict[str, Any]:
    sql = text('''
        WITH RECURSIVE tree AS (
            SELECT io.id, io.object_key, io.object_type, NULL::text AS parent_object_key, 0 AS depth
            FROM infrastructure_object io
            WHERE io.object_key = :root_key
          UNION ALL
            SELECT child.id, child.object_key, child.object_type, parent.object_key, tree.depth + 1
            FROM tree
            JOIN object_relation relation ON relation.object_id = tree.id AND relation.predicate = 'part_of'
            JOIN infrastructure_object child ON child.id = relation.subject_id
            JOIN infrastructure_object parent ON parent.id = relation.object_id
            WHERE tree.depth < 5
        )
        , ranked_tree AS (
            SELECT tree.*,
                   ROW_NUMBER() OVER (PARTITION BY tree.id ORDER BY tree.depth DESC, tree.parent_object_key NULLS LAST) AS path_rank
            FROM tree
        )
        SELECT DISTINCT tree.object_key, tree.object_type, tree.parent_object_key, tree.depth,
               observation.attribute, observation.value_json AS value, observation.unit,
               source.source_key, observation.observed_at, observation.provenance,
               observation.id AS observation_id
        FROM ranked_tree tree
        LEFT JOIN observation ON observation.object_id = tree.id
        LEFT JOIN source ON source.id = observation.source_id
        WHERE tree.path_rank = 1
        ORDER BY tree.depth, tree.object_type, tree.object_key, observation.observed_at, observation_id
    ''')
    with get_engine().connect() as connection:
        rows = [dict(row) for row in connection.execute(sql, {"root_key": root_object_key}).mappings()]
    return build_infrastructure_inventory(rows, station)


def summarize_infrastructure_inventory(inventory: dict[str, Any]) -> dict[str, Any]:
    type_counts = Counter(item["object_type"] for item in inventory["objects"])
    equipment_types: Counter[str] = Counter()
    platform_edges: list[str] = []
    conflicts: list[dict[str, Any]] = []
    root_attributes: set[str] = set()
    entrance_has_coordinates = False

    for item in inventory["objects"]:
        by_attribute: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for observation in item["observations"]:
            by_attribute[observation["attribute"]].append(observation)
        latest_by_attribute: dict[str, list[dict[str, Any]]] = {}
        for attribute, observations in by_attribute.items():
            latest_by_source: dict[str, dict[str, Any]] = {}
            for observation in observations:
                latest_by_source[observation["source_key"]] = observation
            latest = list(latest_by_source.values())
            latest_by_attribute[attribute] = latest
            distinct_values = {
                (json.dumps(obs["value"], sort_keys=True, default=str), obs.get("unit")) for obs in latest
            }
            if len(distinct_values) > 1:
                conflicts.append({"object_key": item["object_key"], "attribute": attribute, "evidence": latest})

        if item["depth"] == 0:
            root_attributes.update(latest_by_attribute)
        if item["object_type"] == "platform_edge" and latest_by_attribute.get("name"):
            platform_edges.append(str(latest_by_attribute["name"][-1]["value"]))
        if item["object_type"] == "equipment" and latest_by_attribute.get("equipment_type"):
            equipment_types[str(latest_by_attribute["equipment_type"][-1]["value"])] += 1
        if item["object_type"] == "entrance":
            entrance_has_coordinates |= {"latitude", "longitude"}.issubset(latest_by_attribute)

    data_gaps = []
    if not {"latitude", "longitude"}.issubset(root_attributes):
        data_gaps.append({"code": "station_coordinates_missing", "source": "openstation_netex"})
    if not entrance_has_coordinates:
        data_gaps.append({"code": "entrance_coordinates_missing", "source": "openstation_netex"})
    if equipment_types.get("LiftEquipment", 0) == 0:
        data_gaps.append({"code": "lift_data_missing", "source": "openstation_netex"})

    def track_sort_key(value: str) -> tuple[int, str]:
        number = re.match(r"\d+", value)
        return (int(number.group()) if number else 10**9, value)

    return {
        "station": inventory["station"], "object_count": inventory["object_count"],
        "object_types": dict(sorted(type_counts.items())),
        "platform_edges": sorted(platform_edges, key=track_sort_key),
        "equipment_types": dict(sorted(equipment_types.items())),
        "conflict_count": len(conflicts), "conflicts": conflicts, "data_gaps": data_gaps,
    }
