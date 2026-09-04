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
    note TEXT
);

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
