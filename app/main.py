import asyncio
from datetime import date
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.collectors.openstation import OpenStationCollector, select_station_identity_from_netex
from app.collectors.osm import OpenStreetMapCollector
from app.collectors.stada import StaDaCollector
from app.collectors.fasta import FaStaCollector
from app.collectors.rinf import RINFCollector
from app.database import database_health
from app.repository import load_infrastructure_inventory, summarize_infrastructure_inventory
from app.seed.friedberg import FRIEDBERG
from app.seed.friedberg_geometry import FRIEDBERG_GEOMETRY
from app.seed.friedberg_projects import FRIEDBERG_PROJECTS, FRIEDBERG_PROJECT_SOURCES
from app.seed.friedberg_service_tracks import FRIEDBERG_SERVICE_TRACKS, FRIEDBERG_SERVICE_TRACK_CONFLICTS, SOURCE_2026 as SERVICE_TRACK_SOURCE
from app.services.change_report import build_change_report
from app.services.aerial_analysis import analyse_osm_platform
from app.services.aerial_learning import store_training_sample
from app.services.station_identity import prioritize_station_identity, resolve_netex_identity as resolve_netex_station_identity, resolve_station_identity
from app.services.dynamic_station_sources import collect_db_station_sources

app = FastAPI(title="Rail Infrastructure Intelligence", version="1.2.0", description="Source-aware digital infrastructure twin for railway stations.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://friedberg-infrastruktur-viewer.jaunty-slug-3693.chatgpt.site",
        "https://friedberg-infrastruktur-viewer.thomas-delete.chatgpt.site",
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

@app.get("/")
def root(): return {"service": "rail-infrastructure-intelligence", "version": "1.2.0", "pilot": "Friedberg (Hess)", "docs": "/docs"}

@app.get("/health")
def health(): return {"status": "ok"}

@app.get("/health/database")
def health_database(): return {"status": "ok" if database_health() else "error"}

@app.get("/stations/resolve-identity")
async def resolve_identity(name: str = Query(min_length=2, max_length=160), latitude: float = Query(ge=47, le=56), longitude: float = Query(ge=5, le=16)):
    try:
        return await resolve_station_identity(name, latitude, longitude)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="OSM identity service is temporarily unavailable") from error

@app.get("/stations/resolve-netex-identity")
async def resolve_netex_identity(name: str = Query(min_length=2, max_length=160), latitude: float | None = Query(default=None, ge=47, le=56), longitude: float | None = Query(default=None, ge=5, le=16)):
    if (latitude is None) != (longitude is None):
        raise HTTPException(status_code=422, detail="latitude and longitude must be supplied together")
    try:
        if latitude is None or longitude is None:
            xml = await OpenStationCollector().fetch_netex()
            return select_station_identity_from_netex(xml, name)
        return await resolve_netex_station_identity(name, latitude, longitude)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="NeTEx identity service is temporarily unavailable") from error

@app.get("/stations/dynamic-sources")
async def dynamic_sources(name: str = Query(min_length=2, max_length=160), latitude: float = Query(ge=47, le=56), longitude: float = Query(ge=5, le=16)):
    netex, osm = await asyncio.gather(
        resolve_netex_station_identity(name, latitude, longitude),
        resolve_station_identity(name, latitude, longitude),
        return_exceptions=True,
    )
    identity = prioritize_station_identity(
        netex if isinstance(netex, dict) else None,
        None,
        osm if isinstance(osm, dict) else None,
    )
    db_sources = await collect_db_station_sources(identity.get("station_number"))
    return {"identity": identity, "sources": {
        "netex": {"status": "active" if isinstance(netex, dict) else "not_found", "role": "primary"},
        "era_rinf": {"status": "available_for_enrichment", "role": "secondary_authority"},
        "openstreetmap": {"status": "active" if isinstance(osm, dict) else "not_found", "role": "geometry_only"},
        **db_sources,
    }}

@app.get("/stations/friedberg-hess")
def friedberg():
    result = dict(FRIEDBERG)
    result.update(projects=FRIEDBERG_PROJECTS, service_tracks=FRIEDBERG_SERVICE_TRACKS, conflicts=FRIEDBERG_SERVICE_TRACK_CONFLICTS, geometry=FRIEDBERG_GEOMETRY)
    return result

@app.get("/stations/friedberg-hess/platforms")
def platforms(): return {"station": FRIEDBERG["name"], "platform_edges": FRIEDBERG["platform_edges"]}

@app.get("/stations/friedberg-hess/service-tracks")
def service_tracks(): return {"station": FRIEDBERG["name"], "service_tracks": FRIEDBERG_SERVICE_TRACKS}

@app.get("/stations/friedberg-hess/projects")
def projects(): return {"station": FRIEDBERG["name"], "projects": FRIEDBERG_PROJECTS}

@app.get("/stations/friedberg-hess/sources")
def sources(): return {"station": FRIEDBERG["name"], "sources": FRIEDBERG["sources"] + FRIEDBERG_PROJECT_SOURCES + [SERVICE_TRACK_SOURCE]}

@app.get("/stations/friedberg-hess/conflicts")
def conflicts(): return {"station": FRIEDBERG["name"], "conflicts": FRIEDBERG_SERVICE_TRACK_CONFLICTS}

@app.get("/stations/friedberg-hess/geometry")
def geometry(): return FRIEDBERG_GEOMETRY

@app.get("/stations/friedberg-hess/state")
def state(at: date = Query(default_factory=date.today)):
    return {"station": FRIEDBERG["name"], "requested_date": at.isoformat(), "existing": FRIEDBERG, "projects": FRIEDBERG_PROJECTS}

@app.get("/stations/friedberg-hess/change-report/openstation")
async def openstation_change_report(persist: bool = False):
    return await build_change_report(OpenStationCollector(), FRIEDBERG["name"], persist=persist)

@app.get("/stations/friedberg-hess/change-report/osm")
async def osm_change_report(persist: bool = False):
    return await build_change_report(OpenStreetMapCollector(), FRIEDBERG["name"], persist=persist)

@app.get("/stations/friedberg-hess/aerial-analysis/osm")
async def osm_aerial_analysis(track: str = Query(min_length=1, max_length=4, pattern=r"^\d+[a-zA-Z]?$")):
    try:
        return await analyse_osm_platform(track)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Luftbild- oder OSM-Quelle ist vorübergehend nicht erreichbar") from error


class AerialTrainingFeedback(BaseModel):
    track: str
    endpoint: str
    accepted: bool
    features: dict
    corrected_coordinate: dict[str, float] | None = None
    confirmed_coordinate: dict[str, float] | None = None
    clear_corrected_coordinate: bool = False


@app.post("/stations/friedberg-hess/aerial-analysis/training-feedback")
def aerial_training_feedback(feedback: AerialTrainingFeedback):
    if feedback.endpoint not in {"start", "end"}:
        raise HTTPException(status_code=422, detail="endpoint must be start or end")
    stored = store_training_sample(feedback.track, feedback.endpoint, feedback.accepted, feedback.features,
                                   feedback.corrected_coordinate, feedback.confirmed_coordinate,
                                   feedback.clear_corrected_coordinate)
    return {"stored": stored, "learning": "supervised_online_logistic_regression"}

@app.get("/stations/friedberg-hess/change-report/rinf")
async def rinf_change_report(persist: bool = False):
    return await build_change_report(RINFCollector(), FRIEDBERG["name"], persist=persist)

async def _configured_report(collector, persist: bool):
    if not collector.configured:
        raise HTTPException(status_code=503, detail=f"{collector.name} is not configured")
    try:
        return await build_change_report(collector, FRIEDBERG["name"], persist=persist)
    except httpx.HTTPStatusError as error:
        raise HTTPException(status_code=502, detail={
            "source": collector.name,
            "upstream_status": error.response.status_code,
            "message": "DB API request failed; verify the product subscription for this application",
        }) from error

@app.get("/stations/friedberg-hess/change-report/stada")
async def stada_change_report(persist: bool = False):
    return await _configured_report(StaDaCollector(), persist)

@app.get("/stations/friedberg-hess/change-report/fasta")
async def fasta_change_report(persist: bool = False):
    return await _configured_report(FaStaCollector(), persist)

@app.get("/stations/friedberg-hess/source-status")
def source_status():
    stada, fasta = StaDaCollector(), FaStaCollector()
    return {"station": FRIEDBERG["name"], "sources": [
        {"key": "db-infrago-openstation-netex", "name": "DB InfraGO OpenStation / NeTEx", "configured": True, "quality_class": "A"},
        {"key": "openstreetmap", "name": "OpenStreetMap", "configured": True, "quality_class": "D"},
        {"key": "geoportal-hessen-dop20", "name": "Geodatenviewer Hessen / DOP20", "configured": True, "quality_class": "A"},
        {"key": "era-rinf", "name": "ERA Infrastrukturregister RINF", "configured": True, "quality_class": "A"},
        {"key": "db-infrago-stada", "name": "DB InfraGO StaDa", "configured": stada.configured, "quality_class": "A"},
        {"key": "db-infrago-fasta", "name": "DB InfraGO FaSta", "configured": fasta.configured, "quality_class": "A"},
    ]}

@app.get("/stations/friedberg-hess/infrastructure/openstation")
def openstation_infrastructure():
    return load_infrastructure_inventory(
        "FRI-NETEX-dhid:de:06440:6401:EdB",
        FRIEDBERG["name"],
    )

@app.get("/stations/friedberg-hess/state/openstation")
def openstation_state():
    inventory = load_infrastructure_inventory(
        "FRI-NETEX-dhid:de:06440:6401:EdB",
        FRIEDBERG["name"],
    )
    return summarize_infrastructure_inventory(inventory)

@app.get("/stations/friedberg-hess/data-gaps")
def data_gaps(): return {"station": FRIEDBERG["name"], "data_gaps": FRIEDBERG["data_gaps"]}
