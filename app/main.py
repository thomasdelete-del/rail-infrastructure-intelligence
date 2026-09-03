from fastapi import FastAPI

from app.seed.friedberg import FRIEDBERG
from app.seed.friedberg_projects import FRIEDBERG_PROJECTS, FRIEDBERG_PROJECT_SOURCES
from app.seed.friedberg_service_tracks import (
    FRIEDBERG_SERVICE_TRACKS,
    FRIEDBERG_SERVICE_TRACK_CONFLICTS,
    SOURCE_2026 as SERVICE_TRACK_SOURCE,
)

app = FastAPI(
    title="Rail Infrastructure Intelligence",
    version="0.3.0",
    description="Source-aware digital infrastructure twin for railway stations.",
)


@app.get("/")
def root():
    return {"service": "rail-infrastructure-intelligence", "version": "0.3.0", "pilot": "Friedberg (Hess)", "docs": "/docs"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/stations/friedberg-hess")
def friedberg():
    result = dict(FRIEDBERG)
    result["projects"] = FRIEDBERG_PROJECTS
    result["service_tracks"] = FRIEDBERG_SERVICE_TRACKS
    result["conflicts"] = FRIEDBERG_SERVICE_TRACK_CONFLICTS
    return result


@app.get("/stations/friedberg-hess/platforms")
def friedberg_platforms():
    return {"station": FRIEDBERG["name"], "platform_edges": FRIEDBERG["platform_edges"]}


@app.get("/stations/friedberg-hess/service-tracks")
def friedberg_service_tracks():
    return {"station": FRIEDBERG["name"], "service_tracks": FRIEDBERG_SERVICE_TRACKS}


@app.get("/stations/friedberg-hess/projects")
def friedberg_projects():
    return {"station": FRIEDBERG["name"], "projects": FRIEDBERG_PROJECTS}


@app.get("/stations/friedberg-hess/sources")
def friedberg_sources():
    return {"station": FRIEDBERG["name"], "sources": FRIEDBERG["sources"] + FRIEDBERG_PROJECT_SOURCES + [SERVICE_TRACK_SOURCE]}


@app.get("/stations/friedberg-hess/conflicts")
def friedberg_conflicts():
    return {"station": FRIEDBERG["name"], "conflicts": FRIEDBERG_SERVICE_TRACK_CONFLICTS}


@app.get("/stations/friedberg-hess/data-gaps")
def friedberg_data_gaps():
    return {"station": FRIEDBERG["name"], "data_gaps": FRIEDBERG["data_gaps"]}
