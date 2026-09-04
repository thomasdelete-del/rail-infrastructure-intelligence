from datetime import date
from fastapi import FastAPI, Query
from app.collectors.openstation import OpenStationCollector
from app.database import database_health
from app.repository import load_infrastructure_inventory
from app.seed.friedberg import FRIEDBERG
from app.seed.friedberg_geometry import FRIEDBERG_GEOMETRY
from app.seed.friedberg_projects import FRIEDBERG_PROJECTS, FRIEDBERG_PROJECT_SOURCES
from app.seed.friedberg_service_tracks import FRIEDBERG_SERVICE_TRACKS, FRIEDBERG_SERVICE_TRACK_CONFLICTS, SOURCE_2026 as SERVICE_TRACK_SOURCE
from app.services.change_report import build_change_report

app = FastAPI(title="Rail Infrastructure Intelligence", version="0.8.0", description="Source-aware digital infrastructure twin for railway stations.")

@app.get("/")
def root(): return {"service": "rail-infrastructure-intelligence", "version": "0.8.0", "pilot": "Friedberg (Hess)", "docs": "/docs"}

@app.get("/health")
def health(): return {"status": "ok"}

@app.get("/health/database")
def health_database(): return {"status": "ok" if database_health() else "error"}

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

@app.get("/stations/friedberg-hess/infrastructure/openstation")
def openstation_infrastructure():
    return load_infrastructure_inventory(
        "FRI-NETEX-dhid:de:06440:6401:EdB",
        FRIEDBERG["name"],
    )

@app.get("/stations/friedberg-hess/data-gaps")
def data_gaps(): return {"station": FRIEDBERG["name"], "data_gaps": FRIEDBERG["data_gaps"]}
