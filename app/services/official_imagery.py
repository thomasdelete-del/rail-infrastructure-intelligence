from __future__ import annotations

from typing import Any

import httpx


SERVICES: dict[str, dict[str, str]] = {
    "Hessen": {
        "url": "https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows",
        "layers": "he_dop20_rgb",
        "attribution": "© Hessische Verwaltung für Bodenmanagement und Geoinformation · DL-DE Zero-2.0",
    },
    "Nordrhein-Westfalen": {
        "url": "https://www.wms.nrw.de/geobasis/wms_nw_dop",
        "layers": "nw_dop_rgb",
        "attribution": "© Land NRW / Bezirksregierung Köln · DL-DE Zero-2.0",
    },
    "Bayern": {
        "url": "https://geoservices.bayern.de/od/wms/dop/v1/dop20",
        "layers": "by_dop20c",
        "attribution": "© Bayerische Vermessungsverwaltung",
    },
    "Baden-Württemberg": {
        "url": "https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C",
        "layers": "IMAGES_DOP_20_RGB",
        "attribution": "© LGL Baden-Württemberg · DL-DE BY-2.0",
    },
}


async def find_official_imagery(latitude: float, longitude: float) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
        response = await client.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"format": "jsonv2", "lat": latitude, "lon": longitude, "zoom": 5, "addressdetails": 1},
            headers={"User-Agent": "rail-infrastructure-intelligence/1.6"},
        )
        response.raise_for_status()
    state = str((response.json().get("address") or {}).get("state") or "").strip()
    service = SERVICES.get(state)
    return {
        "state": state or None,
        "available": service is not None,
        "service": service,
        "searched": "official state DOP20 WMS",
    }
