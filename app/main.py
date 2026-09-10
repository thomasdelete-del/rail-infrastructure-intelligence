import asyncio
from datetime import UTC, date, datetime, timedelta
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from app.collectors.openstation import OpenStationCollector, extract_station_stop_place, select_station_identity_from_netex, stop_place_inventory
from app.collectors.osm import OpenStreetMapCollector
from app.collectors.stada import StaDaCollector
from app.collectors.fasta import FaStaCollector
from app.collectors.rinf import RINFCollector
from app.database import database_health
from app.repository import load_infrastructure_inventory, load_source_freshness, load_station_location, load_station_locations, summarize_infrastructure_inventory
from app.seed.friedberg import FRIEDBERG
from app.seed.friedberg_geometry import FRIEDBERG_GEOMETRY
from app.seed.friedberg_projects import FRIEDBERG_PROJECTS, FRIEDBERG_PROJECT_SOURCES
from app.seed.friedberg_service_tracks import FRIEDBERG_SERVICE_TRACKS, FRIEDBERG_SERVICE_TRACK_CONFLICTS, SOURCE_2026 as SERVICE_TRACK_SOURCE
from app.services.change_report import build_change_report
from app.services.aerial_analysis import analyse_osm_platform
from app.services.aerial_learning import delete_station_endpoint_changes, store_training_sample
from app.services.station_identity import netex_xml, prioritize_station_identity, resolve_netex_identity as resolve_netex_station_identity, resolve_stada_identity, resolve_station_identity, search_netex_stations, stada_station_list
from app.services.dynamic_station_sources import collect_db_station_sources
from app.services.platform_data import load_platform_data
from app.services.osm_platforms import load_osm_platforms
from app.services.platform_matching import fetch_station_data, load_matching_statistics, sync_all_stations, sync_osm_station_identities

app = FastAPI(title="Rail Infrastructure Intelligence", version="1.2.0", description="Source-aware digital infrastructure twin for railway stations.")
_matching_sync_task: asyncio.Task | None = None
_matching_sync_status: dict = {
    "status": "pending", "started_at": None, "completed_at": None, "error": None,
    "sources": {
        "db_infrago": {"status": "pending", "records": 0},
        "isr": {"status": "pending", "records": 0},
        "osm": {"status": "pending", "records": 0},
    },
}
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


async def _run_matching_sync() -> None:
    sources = _matching_sync_status["sources"]
    for source in sources.values():
        source.update(status="pending", records=0, error=None)
    _matching_sync_status.update(status="running", started_at=datetime.now(UTC), completed_at=None, error=None)
    try:
        sources["db_infrago"]["status"] = "running"
        stations = await stada_station_list()
        sources["db_infrago"].update(status="available", records=len(stations))
        statistics = load_matching_statistics()
        last_checked = statistics.get("last_checked_at")
        isr_is_current = (
            statistics.get("platform_rows", 0) > 0
            and last_checked is not None
            and datetime.now(UTC) - last_checked.astimezone(UTC) < timedelta(hours=24)
        )
        if isr_is_current:
            sources["isr"].update(status="available", records=statistics["platform_rows"])
            sources["osm"]["status"] = "running"
            try:
                osm_result = await sync_osm_station_identities()
                sources["osm"].update(status="completed", records=osm_result["stations"])
                result = {"isr": "available", "osm": osm_result}
            except Exception as error:
                sources["osm"].update(status="failed", error=str(error))
                result = {"isr": "available", "source_errors": {"osm": f"{type(error).__name__}: {error}"}}
        else:
            sources["isr"]["status"] = "running"
            sources["osm"]["status"] = "running"
            result = await sync_all_stations(25)
            sources["isr"].update(status="completed", records=result.get("rows", 0))
            if result.get("source_errors", {}).get("osm"):
                sources["osm"].update(status="failed", error=result["source_errors"]["osm"])
            else:
                sources["osm"].update(status="completed", records=result.get("stations", 0))
        final_status = "partial" if any(source["status"] == "failed" for source in sources.values()) else "completed"
        _matching_sync_status.update(status=final_status, completed_at=datetime.now(UTC), result=result)
    except Exception as error:
        for source in sources.values():
            if source["status"] == "running":
                source.update(status="failed", error=str(error))
        _matching_sync_status.update(status="failed", completed_at=datetime.now(UTC), error=str(error))


def _start_matching_sync() -> bool:
    global _matching_sync_task
    if _matching_sync_task is not None and not _matching_sync_task.done():
        return False
    _matching_sync_task = asyncio.create_task(_run_matching_sync())
    return True


@app.on_event("startup")
async def start_isr_background_sync():
    _start_matching_sync()


@app.get("/matching/stations/fetch")
async def matching_fetch_station(rl100: str | None = None, stel_id: str | None = None):
    try:
        return await fetch_station_data(rl100, stel_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Matching source temporarily unavailable") from error


@app.post("/matching/stations/sync")
async def matching_sync_all(concurrency: int = Query(default=75, ge=1, le=100)):
    started = _start_matching_sync()
    return {"started": started, "sync": _matching_sync_status}


@app.get("/matching/statistics")
def matching_statistics():
    try:
        return {**load_matching_statistics(), "sync": _matching_sync_status}
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

@app.get("/sources/freshness")
def source_freshness():
    try:
        return load_source_freshness()
    except RuntimeError:
        return {"last_database_update": None, "sources": [], "status": "database_not_configured"}

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

@app.get("/stations/search-netex")
async def search_netex(query: str = Query(min_length=1, max_length=100), limit: int = Query(default=12, ge=1, le=30)):
    try:
        return {"source": "DB InfraGO NeTEx", "stations": await search_netex_stations(query, limit)}
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="NeTEx station list is temporarily unavailable") from error

@app.get("/stations/stada-list")
async def stations_stada_list():
    try:
        stations = await stada_station_list()
        stored_at = None
        try:
            stored = load_station_locations()
            stored_at = stored[0].get("stored_at") if stored else None
        except RuntimeError:
            pass
        return {"source": "DB InfraGO StaDa", "storage": "Railway PostgreSQL snapshot", "stored_at": stored_at, "stations": stations, "count": len(stations)}
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="StaDa station list is temporarily unavailable") from error


@app.get("/stations/materialized-identity")
def station_materialized_identity(station_number: int = Query(ge=1)):
    """Return the Railway-hosted station key immediately, without live source checks."""
    try:
        station = load_station_location(station_number)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if station is None:
        raise HTTPException(status_code=404, detail="Station is not present in the Railway snapshot")
    return {
        "matched_name": station["name"],
        "station_number": str(station["station_number"]),
        "eva": str(station["eva"]) if station.get("eva") is not None else None,
        "ril": station.get("ril"),
        "latitude": station.get("latitude"),
        "longitude": station.get("longitude"),
        "stored_at": station.get("stored_at"),
        "storage": "Railway PostgreSQL snapshot",
    }

@app.get("/stations/dynamic-sources")
async def dynamic_sources(name: str = Query(min_length=2, max_length=160), latitude: float = Query(ge=47, le=56), longitude: float = Query(ge=5, le=16)):
    stada, netex, osm = await asyncio.gather(
        resolve_stada_identity(name, latitude, longitude),
        resolve_netex_station_identity(name, latitude, longitude),
        resolve_station_identity(name, latitude, longitude),
        return_exceptions=True,
    )
    identity = prioritize_station_identity(
        netex if isinstance(netex, dict) else None,
        None,
        osm if isinstance(osm, dict) else None,
        stada=stada if isinstance(stada, dict) else None,
    )
    db_sources = await collect_db_station_sources(identity.get("station_number"))
    return {"identity": identity, "sources": {
        "stada": {"status": "active" if isinstance(stada, dict) else "not_found", "role": "primary"},
        "netex": {"status": "active" if isinstance(netex, dict) else "not_found", "role": "infrastructure_enrichment"},
        "era_rinf": {"status": "available_for_enrichment", "role": "secondary_authority"},
        "openstreetmap": {"status": "active" if isinstance(osm, dict) else "not_found", "role": "geometry_only"},
        **db_sources,
    }}

@app.get("/stations/platform-data")
async def station_platform_data(name: str = Query(min_length=2, max_length=160), ril: str = Query(min_length=2, max_length=12)):
    try:
        return await load_platform_data(name, ril)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Platform data sources are temporarily unavailable") from error


@app.get("/stations/osm-platforms")
async def station_osm_platforms(latitude: float = Query(ge=47, le=56), longitude: float = Query(ge=5, le=16), rl100: str | None = Query(default=None, min_length=2, max_length=12)):
    return await load_osm_platforms(latitude, longitude, rl100)


@app.get("/stations/infrastructure")
async def station_infrastructure(name: str = Query(min_length=2, max_length=160), latitude: float = Query(ge=47, le=56), longitude: float = Query(ge=5, le=16)):
    """Build the same NeTEx object catalogue for every identity-matched station."""
    try:
        xml = await netex_xml()
        identity = select_station_identity_from_netex(xml, name, latitude, longitude)
        return stop_place_inventory(extract_station_stop_place(xml, identity["netex_id"]))
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="NeTEx infrastructure is temporarily unavailable") from error

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
async def osm_aerial_analysis(
    track: str = Query(min_length=1, max_length=4, pattern=r"^\d+[a-zA-Z]?$"),
    start_latitude: float | None = Query(default=None, ge=47, le=56),
    start_longitude: float | None = Query(default=None, ge=5, le=16),
    end_latitude: float | None = Query(default=None, ge=47, le=56),
    end_longitude: float | None = Query(default=None, ge=5, le=16),
):
    try:
        return await analyse_osm_platform(
            track,
            start_latitude=start_latitude,
            start_longitude=start_longitude,
            end_latitude=end_latitude,
            end_longitude=end_longitude,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except httpx.HTTPError as error:
        raise HTTPException(status_code=502, detail="Luftbild- oder OSM-Quelle ist vorübergehend nicht erreichbar") from error


@app.get("/stations/aerial-analysis/osm")
async def station_aerial_analysis(
    name: str = Query(min_length=2, max_length=160),
    track: str = Query(min_length=1, max_length=20),
    latitude: float = Query(ge=47, le=56),
    longitude: float = Query(ge=5, le=16),
    start_latitude: float | None = Query(default=None, ge=47, le=56),
    start_longitude: float | None = Query(default=None, ge=5, le=16),
    end_latitude: float | None = Query(default=None, ge=47, le=56),
    end_longitude: float | None = Query(default=None, ge=5, le=16),
):
    try:
        return await analyse_osm_platform(
            track,
            name,
            latitude,
            longitude,
            start_latitude,
            start_longitude,
            end_latitude,
            end_longitude,
        )
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
    promote_to_primary: bool = False


class StationEndpointChangesDelete(BaseModel):
    station: str


@app.post("/stations/friedberg-hess/aerial-analysis/training-feedback")
def aerial_training_feedback(feedback: AerialTrainingFeedback):
    if feedback.endpoint not in {"start", "end"}:
        raise HTTPException(status_code=422, detail="endpoint must be start or end")
    stored = store_training_sample(feedback.track, feedback.endpoint, feedback.accepted, feedback.features,
                                   feedback.corrected_coordinate, feedback.confirmed_coordinate,
                                   feedback.clear_corrected_coordinate,
                                   feedback.promote_to_primary)
    return {"stored": stored, "learning": "supervised_online_logistic_regression"}

@app.post("/stations/aerial-analysis/training-feedback")
def generic_aerial_training_feedback(feedback: AerialTrainingFeedback):
    return aerial_training_feedback(feedback)


@app.post("/stations/aerial-analysis/endpoint-changes/delete")
def delete_endpoint_changes(request: StationEndpointChangesDelete):
    station = request.station.strip()
    if not station:
        raise HTTPException(status_code=422, detail="station must not be empty")
    try:
        deleted = delete_station_endpoint_changes(station)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"station": station, "deleted": deleted}

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
        {"key": "era-rinf", "name": "ERA Infrastrukturregister RINF (rinf-plus)", "configured": True, "quality_class": "A"},
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
