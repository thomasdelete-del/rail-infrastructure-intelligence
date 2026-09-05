# Rail Infrastructure Intelligence

Source-based infrastructure intelligence for planning, renewal and maintenance of German railway stations.

## Pilot

The first reference station is **Friedberg (Hess)**. The system is designed as a source-aware digital infrastructure twin: every infrastructure fact is stored as an observation with provenance, validity and quality instead of overwriting conflicting values.

## Principles

- primary sources first
- every observation has provenance
- historical, current and planned states remain separate
- conflicts are preserved and made visible
- derived values are explicitly marked
- spatial data is PostGIS-ready
- REST API for downstream GIS and AI applications

## v0.1 scope

- FastAPI backend
- PostgreSQL/PostGIS schema
- generic infrastructure object model
- observations and source registry
- Friedberg (Hess) seed dataset
- data-gap and conflict model
- collector interface for public infrastructure sources

## Planned source families

DB InfraGO/OpenStation/StaDa, EBA, federal and Hessian geodata, Stadt Friedberg, Wetteraukreis, planning approval documents, tenders, environmental and monument data, and other verifiable public sources.

## Connected live sources

- DB InfraGO OpenStation / NeTEx (public, authoritative infrastructure inventory)
- OpenStreetMap via Overpass (public, community geodata; coordinates and nearby mapped infrastructure)
- Geodatenviewer Hessen DOP20 WMS (official orthophoto overlay, DL-DE Zero 2.0)
- DB InfraGO StaDa (authoritative master data; set `DB_API_CLIENT_ID` and `DB_API_KEY`)
- DB InfraGO FaSta (authoritative lift/escalator status; uses the same credentials)

Each source has an independent change-report endpoint below
`/stations/friedberg-hess/change-report/`. Availability is exposed at
`/stations/friedberg-hess/source-status`.

## Quality classes

| Class | Meaning |
|---|---|
| A | current authoritative primary source |
| B | reliable but older primary source |
| C | multiple agreeing secondary sources |
| D | single secondary source |
| E | GIS/image-derived |
| F | uncertain or conflicting |

## Local development

```bash
cp .env.example .env
docker compose up --build
```

API documentation will be available at `/docs`.
