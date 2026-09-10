CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS source (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_key TEXT UNIQUE NOT NULL,
    publisher TEXT NOT NULL,
    title TEXT,
    url TEXT,
    source_type TEXT NOT NULL,
    source_date DATE,
    retrieval_date TIMESTAMPTZ DEFAULT now(),
    quality_class CHAR(1) CHECK (quality_class IN ('A','B','C','D','E','F')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS infrastructure_object (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_key TEXT UNIQUE NOT NULL,
    object_type TEXT NOT NULL,
    name TEXT,
    parent_id UUID REFERENCES infrastructure_object(id),
    geometry geometry(Geometry, 4326),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS observation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID NOT NULL REFERENCES infrastructure_object(id) ON DELETE CASCADE,
    attribute TEXT NOT NULL,
    value_json JSONB NOT NULL,
    unit TEXT,
    source_id UUID NOT NULL REFERENCES source(id),
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    observed_at TIMESTAMPTZ,
    method TEXT DEFAULT 'source',
    is_derived BOOLEAN NOT NULL DEFAULT FALSE,
    confidence NUMERIC(4,3) CHECK (confidence >= 0 AND confidence <= 1),
    note TEXT,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE observation ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS object_relation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id UUID NOT NULL REFERENCES infrastructure_object(id) ON DELETE CASCADE,
    predicate TEXT NOT NULL,
    object_id UUID NOT NULL REFERENCES infrastructure_object(id) ON DELETE CASCADE,
    source_id UUID REFERENCES source(id),
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    UNIQUE(subject_id, predicate, object_id, valid_from)
);

-- Backfill the hierarchy encoded by source-level NeTEx identifiers. This is
-- deliberately append-only and source-specific; no existing relation wins.
INSERT INTO object_relation (subject_id, predicate, object_id, source_id)
SELECT DISTINCT child_object.id, 'part_of', parent_object.id, child_observation.source_id
FROM observation child_observation
JOIN infrastructure_object child_object ON child_object.id = child_observation.object_id
JOIN observation parent_observation
  ON parent_observation.source_id = child_observation.source_id
 AND parent_observation.provenance->>'netex_id' = child_observation.provenance->>'parent_netex_id'
JOIN infrastructure_object parent_object ON parent_object.id = parent_observation.object_id
WHERE child_observation.provenance->>'parent_netex_id' IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM object_relation existing
      WHERE existing.subject_id = child_object.id
        AND existing.predicate = 'part_of'
        AND existing.object_id = parent_object.id
        AND existing.source_id = child_observation.source_id
  );

CREATE TABLE IF NOT EXISTS project (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    planned_start DATE,
    planned_end DATE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS project_object (
    project_id UUID REFERENCES project(id) ON DELETE CASCADE,
    object_id UUID REFERENCES infrastructure_object(id) ON DELETE CASCADE,
    role TEXT,
    PRIMARY KEY (project_id, object_id)
);

CREATE TABLE IF NOT EXISTS conflict (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID REFERENCES infrastructure_object(id) ON DELETE CASCADE,
    attribute TEXT NOT NULL,
    observation_ids UUID[] NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS data_gap (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    object_id UUID REFERENCES infrastructure_object(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'open',
    note TEXT
);

CREATE INDEX IF NOT EXISTS idx_object_geometry ON infrastructure_object USING GIST (geometry);
CREATE INDEX IF NOT EXISTS idx_observation_object_attribute ON observation(object_id, attribute);
CREATE INDEX IF NOT EXISTS idx_observation_source ON observation(source_id);

-- One-time StaDa snapshot used by the Germany map. StaDa remains the primary
-- source; normal map requests read this Railway-hosted materialization only.
CREATE TABLE IF NOT EXISTS station_location_snapshot (
    station_number INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    eva BIGINT,
    ril TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    source_key TEXT NOT NULL DEFAULT 'db-infrago-stada',
    stored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_station_location_snapshot_name
    ON station_location_snapshot (name);

CREATE TABLE IF NOT EXISTS betriebsstelle (
    stel_id TEXT PRIMARY KEY,
    ds100_rl100 TEXT NOT NULL UNIQUE,
    bahnhofsname TEXT NOT NULL,
    streckennummer TEXT,
    personenverkehr BOOLEAN NOT NULL DEFAULT FALSE,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bahnsteige (
    ds100_rl100 TEXT NOT NULL,
    isr_gleisnummer_betrieb TEXT NOT NULL,
    eva_nummer TEXT,
    bahnhofsname TEXT NOT NULL,
    streckennummer TEXT,
    osm_bahnsteig_ref TEXT,
    isr_gleisnummer_verkehr TEXT,
    isr_systemhoehe_cm NUMERIC,
    isr_bahnsteignutzlaenge_m NUMERIC,
    rinf_uopid TEXT,
    rinf_platform_id TEXT,
    rinf_track_id TEXT,
    match_methode TEXT NOT NULL,
    anmerkungen TEXT,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_hash CHAR(64) NOT NULL,
    PRIMARY KEY (ds100_rl100, isr_gleisnummer_betrieb)
);
CREATE INDEX IF NOT EXISTS idx_bahnsteige_station ON bahnsteige (ds100_rl100);

ALTER TABLE bahnsteige
    ADD COLUMN IF NOT EXISTS db_platform_height_mm NUMERIC,
    ADD COLUMN IF NOT EXISTS db_net_construction_length_m NUMERIC;

CREATE TABLE IF NOT EXISTS osm_bahnsteig_cache (
    ds100_rl100 TEXT PRIMARY KEY,
    elements JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
