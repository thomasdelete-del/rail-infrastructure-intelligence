'use client';
import { useEffect, useRef, useState } from 'react';
import { MapPin, Search, TrainFront } from 'lucide-react';
import type { Map as LeafletMap, LayerGroup } from 'leaflet';
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
export function SelectedStationMap({
  station,
  onBack,
}: {
  station: Station;
  onBack: () => void;
}) {
  const el = useRef<HTMLDivElement>(null);
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
  const [loading, setLoading] = useState(true);
  const displayName = /bahnhof$/i.test(station.name.trim())
    ? station.name
    : `${station.name} Bahnhof`;
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ name: station.name, latitude: String(station.latitude), longitude: String(station.longitude) });
    void fetch(`${API}/stations/resolve-identity?${parameters}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then((raw: unknown) => { const value = raw as { matched_name?: string; eva?: string; ril?: string; station_number?: string; osm_type?: string; osm_id?: number }; setIdentity({ name: value.matched_name, eva: value.eva, ril: value.ril, stationNumber: value.station_number, osm: value.osm_type && value.osm_id ? `${value.osm_type}/${value.osm_id}` : undefined }); })
      .catch((error: Error) => { if (error.name !== 'AbortError') setIdentity(null); });
    return () => controller.abort();
  }, [station]);
  useEffect(() => {
    if (!el.current) return;
    let disposed = false;
    let instance: LeafletMap | null = null;
    void import('leaflet').then(async (L) => {
      if (disposed || !el.current) return;
      instance = L.map(el.current, { minZoom: 5, maxZoom: 20 }).setView(
        [station.latitude, station.longitude],
        17,
      );
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 20,
        attribution: '&copy; OpenStreetMap-Mitwirkende',
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
        const query = `[out:json][timeout:25];(nwr(around:1200,${station.latitude},${station.longitude})[railway~"^(station|halt)$"];nwr(around:900,${station.latitude},${station.longitude})[railway=platform];nwr(around:900,${station.latitude},${station.longitude})[public_transport=platform];nwr(around:900,${station.latitude},${station.longitude})[railway=subway_entrance];nwr(around:900,${station.latitude},${station.longitude})[entrance][railway];nwr(around:900,${station.latitude},${station.longitude})[highway=elevator];nwr(around:900,${station.latitude},${station.longitude})[elevator=yes];);out center geom;`;
        const response = await fetch(
          `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
        );
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { elements: OsmElement[] };
        if (disposed) return;
        let platforms = 0,
          entrances = 0,
          equipment = 0;
        const seen = new Set<string>();
        data.elements.forEach((item) => {
          const key = `${item.type}-${item.id}`;
          if (seen.has(key)) return;
          seen.add(key);
          const tags = item.tags ?? {};
          const isPlatform =
            tags.railway === 'platform' || tags.public_transport === 'platform';
          const isStation = ['station', 'halt'].includes(tags.railway ?? '');
          const isEntrance =
            tags.railway === 'subway_entrance' || Boolean(tags.entrance);
          if (isStation) return;
          if (isPlatform) platforms++;
          else if (isEntrance) entrances++;
          else equipment++;
          if (item.geometry?.length && isPlatform) {
            L.polyline(
              item.geometry.map((p) => [p.lat, p.lon] as [number, number]),
              { color: '#00a6c7', weight: 5, opacity: 0.9 },
            )
              .bindTooltip(
                tags.ref ? `Bahnsteig ${escapeHtml(tags.ref)}` : 'Bahnsteig',
              )
              .addTo(instance!);
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
      } catch {
        if (!disposed) setCounts({ platforms: 0, entrances: 0, equipment: 0 });
      } finally {
        if (!disposed) setLoading(false);
      }
    });
    return () => {
      disposed = true;
      instance?.remove();
    };
  }, [displayName, station]);
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
