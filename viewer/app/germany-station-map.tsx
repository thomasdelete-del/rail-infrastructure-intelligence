'use client';
import { useEffect, useRef, useState } from 'react';
import { Layers3, MapPin, Satellite, Search, TrainFront } from 'lucide-react';
import type { Map as LeafletMap, LayerGroup, TileLayer } from 'leaflet';
const API = 'https://rail-infrastructure-intelligence-production.up.railway.app';
export type Station = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  available?: boolean;
};
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
type OsmElement = {
  type: 'node' | 'way';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};
type PlatformEdge = {
  id: string;
  track: string;
  geometry: Array<{ lat: number; lon: number }>;
  length: number;
  height?: string;
};

const distance = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const radians = (value: number) => value * Math.PI / 180;
  const lat1 = radians(a.lat), lat2 = radians(b.lat);
  const dLat = lat2 - lat1, dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const geometryLength = (geometry: Array<{ lat: number; lon: number }>) =>
  geometry.slice(1).reduce((sum, point, index) => sum + distance(geometry[index], point), 0);
export function SelectedStationMap({
  station,
  onBack,
}: {
  station: Station;
  onBack: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const satelliteRef = useRef<TileLayer | null>(null);
  const officialRef = useRef<TileLayer | null>(null);
  const [counts, setCounts] = useState({
    platforms: 0,
    entrances: 0,
    equipment: 0,
  });
  const [identity, setIdentity] = useState<{
    name?: string;
    eva?: string;
    ril?: string;
    stationNumber?: string;
    osm?: string;
  } | null>(null);
  const [dbSources, setDbSources] = useState<{ stada?: string; fasta?: string; facilities?: number }>({});
  const [platformEdges, setPlatformEdges] = useState<PlatformEdge[]>([]);
  const [imagery, setImagery] = useState<'none' | 'satellite' | 'official'>('none');
  const [loading, setLoading] = useState(true);
  const displayName = /bahnhof$/i.test(station.name.trim())
    ? station.name
    : `${station.name} Bahnhof`;
  const officialImageryAvailable = station.latitude >= 49.39 && station.latitude <= 51.66 && station.longitude >= 7.77 && station.longitude <= 10.24;
  const focusEndpoint = (edge: PlatformEdge, endpoint: 'start' | 'end') => {
    const point = endpoint === 'start' ? edge.geometry[0] : edge.geometry.at(-1);
    setImagery(officialImageryAvailable ? 'official' : 'satellite');
    if (point) mapRef.current?.setView([point.lat, point.lon], 21, { animate: false });
  };
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ name: station.name, latitude: String(station.latitude), longitude: String(station.longitude) });
    void fetch(`${API}/stations/dynamic-sources?${parameters}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then((raw: unknown) => { const bundle = raw as { identity: { matched_name?: string; eva?: string; ril?: string; station_number?: string; osm_type?: string; osm_id?: number }; sources?: { stada?: { status?: string }; fasta?: { status?: string; facility_count?: number } } }; const value = bundle.identity; setIdentity({ name: value.matched_name, eva: value.eva, ril: value.ril, stationNumber: value.station_number, osm: value.osm_type && value.osm_id ? `${value.osm_type}/${value.osm_id}` : undefined }); setDbSources({ stada: bundle.sources?.stada?.status, fasta: bundle.sources?.fasta?.status, facilities: bundle.sources?.fasta?.facility_count }); })
      .catch((error: Error) => { if (error.name !== 'AbortError') setIdentity(null); });
    return () => controller.abort();
  }, [station]);
  useEffect(() => {
    if (!el.current) return;
    let disposed = false;
    let instance: LeafletMap | null = null;
    void import('leaflet').then(async (L) => {
      if (disposed || !el.current) return;
      instance = L.map(el.current, { minZoom: 5, maxZoom: 24 }).setView(
        [station.latitude, station.longitude],
        17,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19,
        maxZoom: 24,
        attribution: '&copy; OpenStreetMap-Mitwirkende',
      }).addTo(instance);
      mapRef.current = instance;
      satelliteRef.current = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 19, maxZoom: 24, opacity: 0,
        attribution: 'Satellitenbild &copy; Esri, Maxar, Earthstar Geographics und weitere',
      }).addTo(instance);
      if (officialImageryAvailable) officialRef.current = L.tileLayer.wms('https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows', {
        layers: 'he_dop20_rgb', format: 'image/png', transparent: true, version: '1.1.1', maxZoom: 24, opacity: 0,
        attribution: 'Luftbild: &copy; Hessische Verwaltung für Bodenmanagement und Geoinformation · DL-DE Zero-2.0',
      }).addTo(instance);
      L.circleMarker([station.latitude, station.longitude], {
        radius: 10,
        color: '#fff',
        weight: 3,
        fillColor: '#f5a623',
        fillOpacity: 1,
      })
        .addTo(instance)
        .bindPopup(
          `<strong>${escapeHtml(displayName)}</strong><br>Ausgewählter Bahnhof`,
        )
        .openPopup();
      try {
        const query = `[out:json][timeout:25];(nwr(around:1200,${station.latitude},${station.longitude})[railway~"^(station|halt)$"];nwr(around:900,${station.latitude},${station.longitude})[railway=platform];nwr(around:900,${station.latitude},${station.longitude})[railway=platform_edge];nwr(around:900,${station.latitude},${station.longitude})[public_transport=platform];nwr(around:900,${station.latitude},${station.longitude})[railway=subway_entrance];nwr(around:900,${station.latitude},${station.longitude})[entrance][railway];nwr(around:900,${station.latitude},${station.longitude})[highway=elevator];nwr(around:900,${station.latitude},${station.longitude})[elevator=yes];);out center geom;`;
        const response = await fetch(
          `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
        );
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { elements: OsmElement[] };
        if (disposed) return;
        let platforms = 0,
          entrances = 0,
          equipment = 0;
        const edges: PlatformEdge[] = [];
        const seen = new Set<string>();
        data.elements.forEach((item) => {
          const key = `${item.type}-${item.id}`;
          if (seen.has(key)) return;
          seen.add(key);
          const tags = item.tags ?? {};
          const isPlatform =
            tags.railway === 'platform' || tags.railway === 'platform_edge' || tags.public_transport === 'platform';
          const isPlatformEdge = tags.railway === 'platform_edge';
          const isStation = ['station', 'halt'].includes(tags.railway ?? '');
          const isEntrance =
            tags.railway === 'subway_entrance' || Boolean(tags.entrance);
          if (isStation) return;
          if (isPlatform) platforms++;
          else if (isEntrance) entrances++;
          else equipment++;
          if (item.geometry?.length && isPlatformEdge) {
            const edge = { id: `${item.type}-${item.id}`, track: tags.ref || tags.local_ref || 'ohne Nummer', geometry: item.geometry, length: geometryLength(item.geometry), height: tags.height };
            edges.push(edge);
            L.polyline(
              item.geometry.map((p) => [p.lat, p.lon] as [number, number]),
              { color: '#00a6c7', weight: 5, opacity: 0.9 },
            )
              .bindTooltip(
                tags.ref ? `Bahnsteig ${escapeHtml(tags.ref)}` : 'Bahnsteig',
              )
              .addTo(instance!);
            const start = item.geometry[0], end = item.geometry.at(-1)!;
            L.circleMarker([start.lat, start.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#20a464', fillOpacity: 1 }).addTo(instance!);
            L.circleMarker([end.lat, end.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#d54532', fillOpacity: 1 }).addTo(instance!);
          } else if (item.geometry?.length && isPlatform) {
            L.polyline(item.geometry.map((p) => [p.lat, p.lon] as [number, number]), { color: '#0b5278', weight: 3, opacity: .55 }).addTo(instance!);
          } else {
            const lat = item.lat ?? item.center?.lat,
              lon = item.lon ?? item.center?.lon;
            if (lat !== undefined && lon !== undefined)
              L.circleMarker([lat, lon], {
                radius: 5,
                color: '#fff',
                weight: 2,
                fillColor: isEntrance
                  ? '#20845a'
                  : isPlatform
                    ? '#00a6c7'
                    : '#6f5aa8',
                fillOpacity: 1,
              })
                .bindTooltip(
                  isEntrance
                    ? 'Zugang'
                    : isPlatform
                      ? 'Bahnsteig'
                      : 'Ausstattung',
                )
                .addTo(instance!);
          }
        });
        setCounts({ platforms, entrances, equipment });
        setPlatformEdges(edges.sort((a, b) => a.track.localeCompare(b.track, 'de', { numeric: true })));
      } catch {
        if (!disposed) setCounts({ platforms: 0, entrances: 0, equipment: 0 });
      } finally {
        if (!disposed) setLoading(false);
      }
    });
    return () => {
      disposed = true;
      instance?.remove();
      mapRef.current = null;
      satelliteRef.current = null;
      officialRef.current = null;
    };
  }, [displayName, officialImageryAvailable, station]);
  useEffect(() => {
    satelliteRef.current?.setOpacity(imagery === 'satellite' ? 1 : 0);
    officialRef.current?.setOpacity(imagery === 'official' ? 1 : 0);
  }, [imagery]);
  return (
    <section className="selected-station-card">
      <div className="selected-station-heading">
        <div>
          <p className="map-kicker">KARTENEINSTIEG</p>
          <h2>{displayName} im Lageplan</h2>
          <p>
            Infrastrukturobjekte aus OpenStreetMap/Overpass werden live im
            Bahnhofsumfeld geladen.
          </p>
          <div className="selected-station-meta">
            <span>OpenStreetMap: aktiv</span>
            <span>
              {loading
                ? 'Infrastruktur wird geladen …'
                : `${counts.platforms} Bahnsteige · ${counts.entrances} Zugänge · ${counts.equipment} Ausstattung`}
            </span>
            {identity ? <><span>OSM-ID: {identity.osm}</span><span>EVA/IBNR: {identity.eva ?? 'nicht gepflegt'}</span><span>RIL100: {identity.ril ?? 'nicht gepflegt'}</span><span>DB-Stationsnummer: {identity.stationNumber ?? 'nicht gepflegt'}</span></> : <span>Stationskennung konnte nicht eindeutig ermittelt werden</span>}
            <span>{identity?.eva || identity?.ril || identity?.stationNumber ? 'Identitäts-Gate: Kennung gefunden' : 'DB-Quellen: eindeutige Kennung fehlt'}</span>
            <span>DB StaDa: {dbSources.stada ?? 'wird geprüft'}</span>
            <span>DB FaSta: {dbSources.fasta ?? 'wird geprüft'}{dbSources.facilities !== undefined ? ` · ${dbSources.facilities} Anlagen` : ''}</span>
          </div>
        </div>
        <button type="button" onClick={onBack}>
          Zu Friedberg (Hess)
        </button>
      </div>
      <div
        ref={el}
        className="selected-station-map"
        aria-label={`Lageplan ${displayName}`}
      />
      <div className="generic-map-controls" aria-label="Kartenebenen">
        <button type="button" className={imagery === 'satellite' ? 'map-toggle map-toggle-active' : 'map-toggle'} onClick={() => setImagery(imagery === 'satellite' ? 'none' : 'satellite')}><Satellite size={16}/>Satellit</button>
        {officialImageryAvailable ? <button type="button" className={imagery === 'official' ? 'map-toggle map-toggle-active' : 'map-toggle'} onClick={() => setImagery(imagery === 'official' ? 'none' : 'official')}><Layers3 size={16}/>Amtliches Luftbild</button> : null}
      </div>
      <div className="generic-station-metrics">
        <div><strong>{platformEdges.length}</strong><span>Bahnsteigkanten</span></div>
        <div><strong>{counts.entrances}</strong><span>Zugänge</span></div>
        <div><strong>{counts.equipment}</strong><span>Ausstattung</span></div>
        <div><strong>{identity?.stationNumber ?? '–'}</strong><span>DB-Stationsnummer</span></div>
      </div>
      <div className="platform-check-panel generic-platform-check">
        <div><strong>Bahnsteiganfänge und -enden prüfen</strong><span>Jeder Endpunkt springt direkt in denselben Luftbildzoom wie in Friedberg.</span></div>
        <span className="status-ok">OSM-Geometrie geladen</span>
      </div>
      <div className="generic-platform-scroll">
        <table className="platform-data-table">
          <thead><tr><th>Gleis</th><th>Bahnsteighöhe</th><th>Baulänge OSM</th><th>Nettobaulänge DB</th><th>Gleisbezogene Bahnsteignutzlänge</th><th>Anfang Geokoordinaten</th><th>Ende Geokoordinaten</th></tr></thead>
          <tbody>{platformEdges.map((edge) => {
            const start = edge.geometry[0], end = edge.geometry.at(-1)!;
            return <tr key={edge.id}><td><span className="track-pill">Gleis {edge.track}</span></td><td><div className="data-value"><strong>{edge.height ? `${Number(edge.height) * 1000} mm` : 'Nicht geliefert'}</strong><span>OpenStreetMap</span></div></td><td><div className="data-value"><strong>{edge.length.toFixed(1)} m</strong><span>OSM-Geometrie</span></div></td><td><span className="data-missing">Nicht geliefert</span></td><td><span className="data-missing">Nicht in RINF zugeordnet</span></td><td><button type="button" className="generic-endpoint-button" onClick={() => focusEndpoint(edge, 'start')}><strong>{start.lat.toFixed(6)}, {start.lon.toFixed(6)}</strong><span>Im Luftbild prüfen</span></button></td><td><button type="button" className="generic-endpoint-button" onClick={() => focusEndpoint(edge, 'end')}><strong>{end.lat.toFixed(6)}, {end.lon.toFixed(6)}</strong><span>Im Luftbild prüfen</span></button></td></tr>;
          })}{!loading && !platformEdges.length ? <tr><td colSpan={7}><span className="data-missing">Keine OSM-Bahnsteigkanten im Bahnhofsumfeld gefunden.</span></td></tr> : null}</tbody>
        </table>
      </div>
    </section>
  );
}
const MAJOR: Station[] = [
  {
    id: 'friedberg-hess',
    name: 'Friedberg (Hess)',
    latitude: 50.33269,
    longitude: 8.76126,
    available: true,
  },
  {
    id: 'berlin',
    name: 'Berlin Hauptbahnhof',
    latitude: 52.52508,
    longitude: 13.3694,
  },
  {
    id: 'hamburg',
    name: 'Hamburg Hauptbahnhof',
    latitude: 53.55273,
    longitude: 10.00691,
  },
  {
    id: 'frankfurt',
    name: 'Frankfurt (Main) Hbf',
    latitude: 50.10682,
    longitude: 8.6631,
  },
  {
    id: 'muenchen',
    name: 'München Hauptbahnhof',
    latitude: 48.14023,
    longitude: 11.55834,
  },
  {
    id: 'koeln',
    name: 'Köln Hauptbahnhof',
    latitude: 50.94303,
    longitude: 6.95873,
  },
];
export function GermanyStationMap({
  onSelect,
}: {
  onSelect: (station: Station) => void;
}) {
  const el = useRef<HTMLDivElement>(null),
    map = useRef<LeafletMap | null>(null),
    layer = useRef<LayerGroup | null>(null);
  const [query, setQuery] = useState(''),
    [stations, setStations] = useState(MAJOR),
    [searching, setSearching] = useState(false),
    [message, setMessage] = useState(
      'Friedberg (Hess) ist vollständig verfügbar; weitere Bahnhöfe können gesucht werden.',
    );
  useEffect(() => {
    if (!el.current || map.current) return;
    void import('leaflet').then((L) => {
      if (!el.current || map.current) return;
      map.current = L.map(el.current, { minZoom: 5, maxZoom: 18 }).setView(
        [51.15, 10.45],
        6,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap-Mitwirkende',
      }).addTo(map.current);
      layer.current = L.layerGroup().addTo(map.current);
      setStations((x) => [...x]);
    });
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    if (!map.current || !layer.current) return;
    void import('leaflet').then((L) => {
      layer.current!.clearLayers();
      stations.forEach((s) => {
        const safeName = escapeHtml(s.name);
        const marker = L.circleMarker([s.latitude, s.longitude], {
          radius: s.available ? 9 : 6,
          color: '#fff',
          weight: 2,
          fillColor: s.available ? '#f5a623' : '#0b6b8a',
          fillOpacity: 1,
        })
          .addTo(layer.current!)
          .bindTooltip(safeName)
          .bindPopup(`<strong>${safeName}</strong><br>Bahnhof ausgewählt`);
        marker.on('click', () => {
          map.current?.setView([s.latitude, s.longitude], 16, {
            animate: true,
          });
          marker.openPopup();
          onSelect(s);
          setMessage(
            s.available
              ? `${s.name}: Viewer wird geöffnet.`
              : `${s.name} ausgewählt. Die Datenanbindung folgt.`,
          );
        });
      });
    });
  }, [onSelect, stations]);
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=de&limit=8&q=${encodeURIComponent(`${query} Bahnhof`)}`,
        { headers: { 'Accept-Language': 'de' } },
      );
      if (!r.ok) throw new Error();
      const d = (await r.json()) as Array<{
        place_id: number;
        display_name: string;
        lat: string;
        lon: string;
      }>;
      const found = d
        .map((x) => ({
          id: `osm-${x.place_id}`,
          name: x.display_name.split(',')[0],
          latitude: Number(x.lat),
          longitude: Number(x.lon),
        }))
        .filter(
          (x) => Number.isFinite(x.latitude) && Number.isFinite(x.longitude),
        );
      if (!found.length) {
        setMessage('Kein Bahnhof gefunden.');
        return;
      }
      const first = found[0];
      setStations(found);
      map.current?.setView([first.latitude, first.longitude], 16, {
        animate: true,
      });
      onSelect(first);
      setMessage(
        `${first.name} wird in der Kartenansicht angezeigt. ${found.length > 1 ? 'Weitere Treffer sind ebenfalls markiert.' : ''}`,
      );
    } catch {
      setMessage('Bahnhofssuche ist momentan nicht erreichbar.');
    } finally {
      setSearching(false);
    }
  };
  return (
    <section className="germany-map-card">
      <div className="germany-map-copy">
        <div>
          <p className="map-kicker">BAHNHOF AUSWÄHLEN</p>
          <h2>Deutschlandweite Bahnhofssuche</h2>
          <p>Ort oder Bahnhof eingeben und einen Marker wählen.</p>
        </div>
        <form onSubmit={search}>
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="z. B. Kassel, Köln Hbf"
          />
          <button disabled={searching}>
            {searching ? 'Suche …' : 'Suchen'}
          </button>
        </form>
      </div>
      <div ref={el} className="germany-map" />
      <div className="germany-map-status">
        <TrainFront size={17} />
        <span>{message}</span>
        <MapPin size={16} />
      </div>
    </section>
  );
}
