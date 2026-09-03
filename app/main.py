from fastapi import FastAPI

from app.seed.friedberg import FRIEDBERG

app = FastAPI(
    title="Rail Infrastructure Intelligence",
    version="0.1.0",
    description="Source-aware digital infrastructure twin for railway stations.",
)


@app.get("/")
def root():
    return {
        "service": "rail-infrastructure-intelligence",
        "version": "0.1.0",
        "pilot": "Friedberg (Hess)",
        "docs": "/docs",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/stations/friedberg-hess")
def friedberg():
    return FRIEDBERG


@app.get("/stations/friedberg-hess/platforms")
def friedberg_platforms():
    return {"station": FRIEDBERG["name"], "platform_edges": FRIEDBERG["platform_edges"]}


@app.get("/stations/friedberg-hess/data-gaps")
def friedberg_data_gaps():
    return {"station": FRIEDBERG["name"], "data_gaps": FRIEDBERG["data_gaps"]}
