'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers3, MapPin, Satellite, Search, ShieldCheck, TrainFront } from 'lucide-react';
import type { Map as LeafletMap, LayerGroup, TileLayer } from 'leaflet';
const API = 'https://rail-infrastructure-intelligence-production.up.railway.app';
export type Station = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  available?: boolean;
};
type StaDaStation = {
  station_number: number | string;
  name: string;
  eva?: string | null;
  ril?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};
const normalizeSearch = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('de');
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
  trackSource: 'ref' | 'local_ref' | 'single_platform_fallback' | 'unknown';
  osmType: 'node' | 'way';
  osmId: number;
  geometry: Array<{ lat: number; lon: number }>;
  length: number;
  height?: string;
};
type AuthoritativePlatform = {
  track: string;
  platform_height_mm?: number | null;
  net_construction_length_m?: number | null;
  usable_length_m?: number | null;
  rinf_platform_id?: string | null;
  rinf_track_id?: string | null;
  mapping_method?: string | null;
  mapping_confidence?: string | null;
};
type InventoryObservation = { attribute: string; value: unknown; unit?: string | null; source_key: string; provenance?: Record<string, unknown> };
type InventoryObject = { object_key: string; object_type: string; parent_object_key?: string | null; depth: number; observations: InventoryObservation[] };
type StationInventory = { station: string; object_count: number; objects: InventoryObject[] };
type GenericAerialAnalysis = { status: 'plausible' | 'check' | 'high' | 'insufficient_evidence'; confidence: number; candidate_start?: { latitude: number; longitude: number }; candidate_end?: { latitude: number; longitude: number }; candidate_length_m?: number; maximum_endpoint_shift_m?: number; start_shift_m?: number; end_shift_m?: number; reason?: string };
const objectTypeLabels: Record<string, string> = { stop_place: 'Bahnhof', platform: 'Bahnsteig', platform_edge: 'Bahnsteigkante', entrance: 'Zugang', equipment: 'Ausstattung' };
const inventoryAttributeLabels: Record<string, string> = { name: 'Bezeichnung', public_code: 'Gleis', quay_type: 'Bahnsteigtyp', mobility_impaired_access: 'Barrierefreiheit', wheelchair_access: 'Rollstuhlzugang', step_free_access: 'Stufenfreier Zugang', tactile_guidance_available: 'Taktiles Leitsystem', visual_signs_available: 'Visuelle Anzeigen', equipment_type: 'Ausstattungstyp', number_of_steps: 'Stufen', safe_for_guide_dog: 'Für Blindenführhund geeignet', latitude: 'Breitengrad', longitude: 'Längengrad', station_number: 'Stationsnummer', eva: 'EVA', ril: 'RIL 100' };

const distance = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const radians = (value: number) => value * Math.PI / 180;
  const lat1 = radians(a.lat), lat2 = radians(b.lat);
  const dLat = lat2 - lat1, dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const geometryLength = (geometry: Array<{ lat: number; lon: number }>) =>
  geometry.slice(1).reduce((sum, point, index) => sum + distance(geometry[index], point), 0);

const platformAxis = (geometry: Array<{ lat: number; lon: number }>) => {
  let best: [{ lat: number; lon: number }, { lat: number; lon: number }, number] | null = null;
  geometry.forEach((start, startIndex) => geometry.slice(startIndex + 1).forEach((end) => {
    const length = distance(start, end);
    if (!best || length > best[2]) best = [start, end, length];
  }));
  return best;
};
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
  const [dbSources, setDbSources] = useState<{ netex?: string; rinf?: string; osm?: string; stada?: string; fasta?: string; facilities?: number }>({});
  const [platformEdges, setPlatformEdges] = useState<PlatformEdge[]>([]);
  const [authoritativePlatforms, setAuthoritativePlatforms] = useState<AuthoritativePlatform[]>([]);
  const [inventory, setInventory] = useState<StationInventory | null>(null);
  const [inventoryQuery, setInventoryQuery] = useState('');
  const [inventoryType, setInventoryType] = useState('all');
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(null);
  const [imagery, setImagery] = useState<'none' | 'satellite' | 'official'>('none');
  const [loading, setLoading] = useState(true);
  const [osmGeometryStatus, setOsmGeometryStatus] = useState<'loading' | 'active' | 'unavailable'>('loading');
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [endpointReviews, setEndpointReviews] = useState<Record<string, 'correct' | 'none' | 'corrected'>>({});
  const [osmConfirmed, setOsmConfirmed] = useState<Record<string, boolean>>({});
  const [aerialResults, setAerialResults] = useState<Record<string, GenericAerialAnalysis>>({});
  const [aerialChecksRunning, setAerialChecksRunning] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState<{ edgeId: string; endpoint: 'start' | 'end'; track: string } | null>(null);
  const authoritativeName = identity?.name || station.name;
  const displayName = /bahnhof$/i.test(authoritativeName.trim())
    ? authoritativeName
    : `${authoritativeName} Bahnhof`;
  const officialImageryAvailable = station.latitude >= 49.39 && station.latitude <= 51.66 && station.longitude >= 7.77 && station.longitude <= 10.24;
  useEffect(() => {
    try {
      setOsmConfirmed(JSON.parse(localStorage.getItem(`station-osm-confirmed:${station.id}`) || '{}'));
      setEndpointReviews(JSON.parse(localStorage.getItem(`station-endpoint-reviews:${station.id}`) || '{}'));
    } catch {
      setOsmConfirmed({});
      setEndpointReviews({});
    }
  }, [station.id]);
  useEffect(() => { localStorage.setItem(`station-osm-confirmed:${station.id}`, JSON.stringify(osmConfirmed)); }, [osmConfirmed, station.id]);
  useEffect(() => { localStorage.setItem(`station-endpoint-reviews:${station.id}`, JSON.stringify(endpointReviews)); }, [endpointReviews, station.id]);
  const focusEndpoint = (edge: PlatformEdge, endpoint: 'start' | 'end') => {
    const point = endpoint === 'start' ? edge.geometry[0] : edge.geometry.at(-1);
    setReviewKey(`${edge.id}:${endpoint}`);
    setImagery(officialImageryAvailable ? 'official' : 'satellite');
    if (point) mapRef.current?.setView([point.lat, point.lon], 21, { animate: false });
  };
  const focusPlatformLength = (edge: PlatformEdge) => {
    setReviewKey(null);
    setImagery(officialImageryAvailable ? 'official' : 'satellite');
    if (!edge.geometry.length) return;
    mapRef.current?.fitBounds(edge.geometry.map((point) => [point.lat, point.lon] as [number, number]), { padding: [70, 70], maxZoom: 19, animate: false });
  };
  useEffect(() => {
    if (!correctionTarget || !mapRef.current) return;
    const map = mapRef.current;
    const handleClick = (event: { latlng: { lat: number; lng: number } }) => {
      const coordinate = { lat: event.latlng.lat, lon: event.latlng.lng };
      setPlatformEdges((current) => current.map((edge) => {
        if (edge.id !== correctionTarget.edgeId) return edge;
        const geometry = [...edge.geometry];
        if (correctionTarget.endpoint === 'start') geometry[0] = coordinate;
        else geometry[geometry.length - 1] = coordinate;
        return { ...edge, geometry, length: geometryLength(geometry) };
      }));
      const key = `${correctionTarget.edgeId}:${correctionTarget.endpoint}`;
      setEndpointReviews((current) => ({ ...current, [key]: 'corrected' }));
      void fetch(`${API}/stations/aerial-analysis/training-feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track: `${station.id}:${correctionTarget.track}`, endpoint: correctionTarget.endpoint, accepted: false, features: {}, corrected_coordinate: { latitude: coordinate.lat, longitude: coordinate.lon } }) });
      setCorrectionTarget(null);
    };
    map.once('click', handleClick);
    return () => { map.off('click', handleClick); };
  }, [correctionTarget, station.id]);
  useEffect(() => {
    setIdentity(null);
    setDbSources({});
    setAuthoritativePlatforms([]);
    setInventory(null);
    setSelectedObjectKey(null);
    setAerialResults({});
    setAerialChecksRunning(false);
    const controller = new AbortController();
    const parameters = new URLSearchParams({ name: station.name, latitude: String(station.latitude), longitude: String(station.longitude) });
    void fetch(`${API}/stations/dynamic-sources?${parameters}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then(async (raw: unknown) => { const bundle = raw as { identity: { matched_name?: string; eva?: string; ril?: string; station_number?: string; osm_type?: string; osm_id?: number }; sources?: { netex?: { status?: string }; era_rinf?: { status?: string }; openstreetmap?: { status?: string }; stada?: { status?: string }; fasta?: { status?: string; facility_count?: number } } }; const value = bundle.identity; setIdentity({ name: value.matched_name, eva: value.eva, ril: value.ril, stationNumber: value.station_number, osm: value.osm_type && value.osm_id ? `${value.osm_type}/${value.osm_id}` : undefined }); setDbSources({ netex: bundle.sources?.netex?.status, rinf: bundle.sources?.era_rinf?.status, osm: bundle.sources?.openstreetmap?.status, stada: bundle.sources?.stada?.status, fasta: bundle.sources?.fasta?.status, facilities: bundle.sources?.fasta?.facility_count }); if (value.ril) { const platformParameters = new URLSearchParams({ name: value.matched_name || station.name, ril: value.ril }); const response = await fetch(`${API}/stations/platform-data?${platformParameters}`, { cache: 'no-store', signal: controller.signal }); if (response.ok) { const data = await response.json() as { platforms: AuthoritativePlatform[]; status: { era_rinf?: string } }; setAuthoritativePlatforms(data.platforms); setDbSources((current) => ({ ...current, rinf: data.status.era_rinf })); } } })
      .catch((error: Error) => { if (error.name !== 'AbortError') setIdentity(null); });
    return () => controller.abort();
  }, [station]);
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ name: station.name, latitude: String(station.latitude), longitude: String(station.longitude) });
    void fetch(`${API}/stations/infrastructure?${parameters}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error()))
      .then((data: StationInventory) => { setInventory(data); setSelectedObjectKey(data.objects[0]?.object_key ?? null); })
      .catch((error: Error) => { if (error.name !== 'AbortError') setInventory({ station: station.name, object_count: 0, objects: [] }); });
    return () => controller.abort();
  }, [station]);
  useEffect(() => {
    if (!el.current) return;
    setLoading(true);
    setOsmGeometryStatus('loading');
    setCounts({ platforms: 0, entrances: 0, equipment: 0 });
    setPlatformEdges([]);
    setImagery('none');
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
        const parameters = new URLSearchParams({ latitude: String(station.latitude), longitude: String(station.longitude) });
        const response = await fetch(`${API}/stations/osm-platforms?${parameters}`, { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { elements: OsmElement[] };
        if (disposed) return;
        setOsmGeometryStatus(data.elements.length ? 'active' : 'unavailable');
        let entrances = 0,
          equipment = 0;
        const explicitEdges: PlatformEdge[] = [];
        const platformCandidates: PlatformEdge[] = [];
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
          if (isEntrance) entrances++;
          else if (!isPlatform) equipment++;
          if (item.geometry?.length && isPlatformEdge) {
            const edge = { id: `${item.type}-${item.id}`, track: tags.ref || tags.local_ref || 'ohne Nummer', trackSource: tags.ref ? 'ref' as const : tags.local_ref ? 'local_ref' as const : 'unknown' as const, osmType: item.type, osmId: item.id, geometry: item.geometry, length: geometryLength(item.geometry), height: tags.height };
            explicitEdges.push(edge);
          } else if (item.geometry?.length && isPlatform) {
            L.polyline(item.geometry.map((p) => [p.lat, p.lon] as [number, number]), { color: '#0b5278', weight: 3, opacity: .55 }).addTo(instance!);
            const axis = platformAxis(item.geometry);
            if (axis && axis[2] >= 40 && tags.railway === 'platform') platformCandidates.push({
              id: `${item.type}-${item.id}`, track: tags.ref || tags.local_ref || '',
              trackSource: tags.ref ? 'ref' : tags.local_ref ? 'local_ref' : 'unknown', osmType: item.type, osmId: item.id,
              geometry: [axis[0], axis[1]], length: axis[2], height: tags.height,
            });
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
        const edges = [...explicitEdges];
        const explicitTracks = new Set(explicitEdges.map((edge) => edge.track).filter((track) => track && track !== 'ohne Nummer'));
        platformCandidates.forEach((candidate) => {
          if ((candidate.track && !explicitTracks.has(candidate.track)) || (!candidate.track && !explicitEdges.length)) edges.push(candidate);
        });
        if (edges.length === 1 && !edges[0].track) {
          edges[0].track = '1';
          edges[0].trackSource = 'single_platform_fallback';
        }
        edges.forEach((edge) => {
          L.polyline(edge.geometry.map((point) => [point.lat, point.lon] as [number, number]), { color: '#00a6c7', weight: 5, opacity: .9 })
            .bindTooltip(`Gleis ${escapeHtml(edge.track || 'ohne Nummer')}`).addTo(instance!);
          const start = edge.geometry[0], end = edge.geometry.at(-1)!;
          L.circleMarker([start.lat, start.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#20a464', fillOpacity: 1 }).addTo(instance!);
          L.circleMarker([end.lat, end.lon], { radius: 5, color: '#fff', weight: 2, fillColor: '#d54532', fillOpacity: 1 }).addTo(instance!);
        });
        setCounts({ platforms: edges.length, entrances, equipment });
        setPlatformEdges(edges.sort((a, b) => a.track.localeCompare(b.track, 'de', { numeric: true })));
      } catch {
        if (!disposed) { setCounts({ platforms: 0, entrances: 0, equipment: 0 }); setOsmGeometryStatus('unavailable'); }
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
  const platformRows = useMemo(() => {
    const matched = new Set<string>();
    const rows = authoritativePlatforms.map((data) => {
      const edge = platformEdges.find((candidate) => candidate.track === data.track);
      if (edge) matched.add(edge.id);
      return { track: data.track, edge, data };
    });
    platformEdges.filter((edge) => !matched.has(edge.id)).forEach((edge) => rows.push({ track: edge.track, edge, data: undefined }));
    return rows.sort((a, b) => a.track.localeCompare(b.track, 'de', { numeric: true }));
  }, [authoritativePlatforms, platformEdges]);
  const lengthComparison = (edge?: PlatformEdge, data?: AuthoritativePlatform) => {
    const dbLength = data?.net_construction_length_m;
    if (!edge || dbLength == null || dbLength <= 0) return null;
    const delta = edge.length - dbLength;
    const percent = Math.abs(delta) / dbLength * 100;
    return { delta, percent, level: percent <= 5 ? 'low' : percent <= 15 ? 'check' : 'high' } as const;
  };
  const geometryPlausibility = (edge?: PlatformEdge) => {
    if (!edge || edge.geometry.length < 2 || edge.length <= 0) return { level: 'high' as const, reason: 'Endpunkte oder Linienlänge fehlen' };
    const direct = distance(edge.geometry[0], edge.geometry.at(-1)!);
    const straightness = direct / edge.length;
    if (edge.length < 80) return { level: 'high' as const, reason: 'OSM-Bahnsteigkante ungewöhnlich kurz' };
    if (straightness < .9 || straightness > 1.02) return { level: 'check' as const, reason: 'Linienlänge und Endpunktdistanz sind nicht stimmig' };
    return { level: 'ok' as const, reason: 'OSM-Geometrie intern plausibel' };
  };
  const lengthComparisons = platformRows.map(({ edge, data }) => lengthComparison(edge, data)).filter((item) => item !== null);
  const reviewEndpoints = useMemo(() => platformEdges.flatMap((edge) => ([
    { edge, endpoint: 'start' as const, key: `${edge.id}:start` },
    { edge, endpoint: 'end' as const, key: `${edge.id}:end` },
  ])), [platformEdges]);
  const reviewIndex = Math.max(0, reviewEndpoints.findIndex((item) => item.key === reviewKey));
  const currentReview = reviewKey ? reviewEndpoints[reviewIndex] : null;
  const currentAerial = currentReview ? aerialResults[currentReview.edge.id] : undefined;
  const navigateReview = (direction: -1 | 1) => {
    if (!reviewEndpoints.length) return;
    const next = reviewEndpoints[(reviewIndex + direction + reviewEndpoints.length) % reviewEndpoints.length];
    focusEndpoint(next.edge, next.endpoint);
  };
  const startPlatformReview = () => {
    if (!reviewEndpoints.length) return;
    const next = reviewEndpoints.find((item) => !endpointReviews[item.key]) ?? reviewEndpoints[0];
    focusEndpoint(next.edge, next.endpoint);
    if (Object.keys(aerialResults).length || aerialChecksRunning) return;
    setAerialChecksRunning(true);
    void Promise.all(platformEdges.map(async (edge) => {
      try {
        const parameters = new URLSearchParams({ name: authoritativeName, track: edge.track, latitude: String(station.latitude), longitude: String(station.longitude) });
        const response = await fetch(`${API}/stations/aerial-analysis/osm?${parameters}`, { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const result = await response.json() as GenericAerialAnalysis;
        setAerialResults((current) => ({ ...current, [edge.id]: result }));
      } catch {
        setAerialResults((current) => ({ ...current, [edge.id]: { status: 'insufficient_evidence', confidence: 0, reason: 'Keine eindeutige automatische Luftbildauswertung verfügbar' } }));
      }
    })).finally(() => setAerialChecksRunning(false));
  };
  const reviewedEndpointCount = reviewEndpoints.filter((item) => Boolean(endpointReviews[item.key])).length;
  const rateEndpoint = (status: 'correct' | 'none') => {
    if (!currentReview) return;
    setEndpointReviews((current) => ({ ...current, [currentReview.key]: status }));
    const point = currentReview.endpoint === 'start' ? currentReview.edge.geometry[0] : currentReview.edge.geometry.at(-1)!;
    void fetch(`${API}/stations/aerial-analysis/training-feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track: `${station.id}:${currentReview.edge.track}`, endpoint: currentReview.endpoint, accepted: status === 'correct', features: {}, confirmed_coordinate: status === 'correct' ? { latitude: point.lat, longitude: point.lon } : null }) });
    if (status === 'none') setCorrectionTarget({ edgeId: currentReview.edge.id, endpoint: currentReview.endpoint, track: currentReview.edge.track });
  };
  const applyAerialSuggestion = () => {
    if (!currentReview || !currentAerial?.candidate_start || !currentAerial.candidate_end) return;
    const start = { lat: currentAerial.candidate_start.latitude, lon: currentAerial.candidate_start.longitude };
    const end = { lat: currentAerial.candidate_end.latitude, lon: currentAerial.candidate_end.longitude };
    setPlatformEdges((current) => current.map((edge) => edge.id === currentReview.edge.id ? { ...edge, geometry: [start, end], length: geometryLength([start, end]) } : edge));
    setEndpointReviews((current) => ({ ...current, [`${currentReview.edge.id}:start`]: 'corrected', [`${currentReview.edge.id}:end`]: 'corrected' }));
  };
  const sourceEntries = [
    { name: 'DB InfraGO StaDa', quality: 'A', state: dbSources.stada === 'active' ? 'active' : 'unavailable' },
    { name: 'DB InfraGO OpenStation / NeTEx', quality: 'A', state: dbSources.netex === 'active' ? 'active' : 'unavailable' },
    { name: 'ERA Infrastrukturregister RINF', quality: 'A', state: dbSources.rinf === 'active' ? 'active' : 'unavailable' },
    { name: 'OpenStreetMap', quality: 'D', state: dbSources.osm === 'active' || osmGeometryStatus === 'active' || platformEdges.length > 0 ? 'active' : osmGeometryStatus === 'loading' ? 'loading' : 'unavailable' },
    { name: 'Amtliches Luftbild', quality: 'A', state: officialImageryAvailable ? 'active' : 'unavailable' },
    { name: 'DB InfraGO FaSta', quality: 'A', state: dbSources.fasta === 'active' ? 'active' : 'unavailable' },
  ];
  const inventoryObjects = inventory?.objects ?? [];
  const inventoryCounts = Object.fromEntries(['platform', 'platform_edge', 'entrance', 'equipment'].map((type) => [type, inventoryObjects.filter((item) => item.object_type === type).length]));
  const normalizedInventoryQuery = normalizeSearch(inventoryQuery.trim());
  const filteredInventory = inventoryObjects.filter((item) => {
    if (inventoryType !== 'all' && item.object_type !== inventoryType) return false;
    if (!normalizedInventoryQuery) return true;
    return normalizeSearch([item.object_key, objectTypeLabels[item.object_type], ...item.observations.map((observation) => String(observation.value))].join(' ')).includes(normalizedInventoryQuery);
  });
  const selectedInventoryObject = inventoryObjects.find((item) => item.object_key === selectedObjectKey) ?? filteredInventory[0] ?? null;
  const objectTitle = (item: InventoryObject) => String(item.observations.find((observation) => observation.attribute === 'name')?.value ?? objectTypeLabels[item.object_type] ?? item.object_type);
  const displayInventoryValue = (value: unknown, unit?: string | null) => `${typeof value === 'boolean' ? value ? 'Ja' : 'Nein' : String(value ?? 'Nicht geliefert')}${unit && unit !== 'degree' ? ` ${unit}` : ''}`;
  return (
    <section className="selected-station-card">
      <div className="selected-station-heading">
        <div>
          <p className="map-kicker">KARTENEINSTIEG</p>
          <h2>{displayName} im Lageplan</h2>
          <p>
            Stationsstammdaten aus DB InfraGO StaDa; NeTEx und europäische Register ergänzen. OpenStreetMap liefert nachrangig die Geometrie.
          </p>
          <div className="selected-station-meta">
            <span>DB InfraGO StaDa: {dbSources.stada ?? 'wird geprüft'} · Primärquelle</span>
            <span>DB InfraGO NeTEx: {dbSources.netex ?? 'wird geprüft'} · Infrastrukturergänzung</span>
            <span>ERA RINF: {dbSources.rinf ?? 'wird geprüft'} · amtliche Ergänzung</span>
            <span>OpenStreetMap: {dbSources.osm ?? 'wird geprüft'} · nur Geometrie/Gegenprüfung</span>
            <span>
              {loading
                ? 'Infrastruktur wird geladen …'
                : `${counts.platforms} Bahnsteige · ${counts.entrances} Zugänge · ${counts.equipment} Ausstattung`}
            </span>
            {identity ? <><span>OSM-ID: {identity.osm}</span><span>EVA/IBNR: {identity.eva ?? 'nicht gepflegt'}</span><span>RIL100: {identity.ril ?? 'nicht gepflegt'}</span><span>DB-Stationsnummer: {identity.stationNumber ?? 'nicht gepflegt'}</span></> : <span>Stationskennung konnte nicht eindeutig ermittelt werden</span>}
            <span>{identity?.eva || identity?.ril || identity?.stationNumber ? 'Identitäts-Gate: Kennung gefunden' : 'DB-Quellen: eindeutige Kennung fehlt'}</span>
            <span>DB FaSta: {dbSources.fasta ?? 'wird geprüft'}{dbSources.facilities !== undefined ? ` · ${dbSources.facilities} Anlagen` : ''}</span>
          </div>
        </div>
        <button type="button" onClick={onBack}>
          Zur Deutschlandkarte
        </button>
      </div>
      <div
        ref={el}
        className="selected-station-map"
        aria-label={`Lageplan ${displayName}`}
      />
      {currentReview ? <div className="endpoint-review-nav generic-endpoint-review"><button type="button" onClick={() => navigateReview(-1)} aria-label="Vorherigen Endpunkt prüfen">‹</button><div><strong>Gleis {currentReview.edge.track} · {currentReview.endpoint === 'start' ? 'Anfang' : 'Ende'}</strong><span>{correctionTarget ? 'Richtigen Abschluss in der Karte anklicken' : endpointReviews[currentReview.key] === 'correct' ? 'Abschluss bestätigt' : endpointReviews[currentReview.key] === 'corrected' ? 'Richtiger Abschluss gesetzt' : endpointReviews[currentReview.key] === 'none' ? 'Kein Abschluss – Korrektur erwartet' : currentAerial?.status === 'plausible' ? `Luftbild plausibel · ${Math.round(currentAerial.confidence * 100)}%` : currentAerial?.maximum_endpoint_shift_m != null ? `Abweichung ${currentAerial.maximum_endpoint_shift_m.toFixed(1)} m · ${Math.round(currentAerial.confidence * 100)}%` : aerialChecksRunning ? 'Amtliches Luftbild wird ausgewertet …' : currentAerial?.reason ?? 'Noch nicht geprüft'}</span>{currentAerial?.candidate_length_m != null ? <small>Erkannte Länge: {currentAerial.candidate_length_m.toFixed(1)} m</small> : null}<div className="endpoint-learning-actions"><button type="button" className={endpointReviews[currentReview.key] === 'correct' ? 'learning-correct-active' : ''} onClick={() => rateEndpoint('correct')}>Abschluss korrekt</button><button type="button" className={endpointReviews[currentReview.key] === 'none' ? 'learning-wrong-active' : ''} onClick={() => rateEndpoint('none')}>Kein Abschluss</button><button type="button" className={endpointReviews[currentReview.key] === 'corrected' ? 'learning-corrected-active' : ''} onClick={() => setCorrectionTarget({ edgeId: currentReview.edge.id, endpoint: currentReview.endpoint, track: currentReview.edge.track })}>{endpointReviews[currentReview.key] === 'corrected' ? 'Richtiger Abschluss gesetzt' : 'Richtigen Abschluss setzen'}</button></div></div><button type="button" onClick={() => navigateReview(1)} aria-label="Nächsten Endpunkt prüfen">›</button></div> : null}
      {currentReview && currentAerial?.candidate_start && currentAerial.candidate_end && currentAerial.status !== 'plausible' ? <button type="button" className="generic-aerial-apply" onClick={applyAerialSuggestion}>Luftbildvorschlag als beide Prüfpunkte übernehmen</button> : null}
      <div className="generic-map-controls" aria-label="Kartenebenen">
        <button type="button" className={imagery === 'satellite' ? 'map-toggle map-toggle-active' : 'map-toggle'} onClick={() => setImagery(imagery === 'satellite' ? 'none' : 'satellite')}><Satellite size={16}/>Satellit</button>
        {officialImageryAvailable ? <button type="button" className={imagery === 'official' ? 'map-toggle map-toggle-active' : 'map-toggle'} onClick={() => setImagery(imagery === 'official' ? 'none' : 'official')}><Layers3 size={16}/>Amtliches Luftbild</button> : null}
      </div>
      <div className="generic-station-metrics">
        <div><strong>{platformRows.length}</strong><span>Bahnsteigkanten</span></div>
        <div><strong>{counts.entrances}</strong><span>Zugänge</span></div>
        <div><strong>{counts.equipment}</strong><span>Ausstattung</span></div>
        <div><strong>{identity?.stationNumber ?? '–'}</strong><span>DB-Stationsnummer</span></div>
      </div>
      <section className="generic-feature-card">
        <div className="generic-feature-heading"><div><h2>Datenquellen</h2><p>Aktive Verbindungen und Qualitätsklasse für {authoritativeName}</p></div><strong>{sourceEntries.filter((source) => source.state === 'active').length} von {sourceEntries.length} verbunden</strong></div>
        <div className="source-grid">{sourceEntries.map((source) => <div className="source-row" key={source.name}><span className={`source-indicator ${source.state === 'active' ? 'source-active' : 'source-pending'}`}/><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{source.name}</p><p className="mt-1 text-xs text-muted-foreground">Qualitätsklasse {source.quality}</p></div><span className={source.state === 'active' ? 'source-state-active' : 'source-state-pending'}>{source.state === 'active' ? 'Aktiv' : source.state === 'loading' ? 'Wird geladen' : 'Nicht verfügbar'}</span></div>)}</div>
      </section>
      <section className="generic-feature-card">
        <div className="generic-feature-heading"><div><h2>Bahnsteigübersicht</h2><p>DB-Gleisnummern mit zugeordneten RINF-Infrastrukturkennungen</p></div><span className="status-ok"><ShieldCheck size={15}/>Identität geprüft</span></div>
        <div className="generic-platform-overview">{platformRows.map(({ track, edge, data }, index) => { const check = lengthComparison(edge, data); return <div className="generic-platform-row" key={`overview-${track}`}><strong>B{index + 1}</strong><div><span>Bahnsteig Gleis {track}</span><div><span className="track-pill">Gleis {track}</span>{data?.rinf_platform_id ? <small>RINF {data.rinf_platform_id}{data.rinf_platform_id !== track ? ` → Gleis ${track}` : ''}</small> : <small>RINF nicht zugeordnet</small>}{check ? <small>{Math.abs(check.delta).toFixed(1)} m Abweichung · {check.level === 'low' ? 'gering' : check.level === 'check' ? 'prüfen' : 'auffällig'}</small> : null}</div></div><i className={check ? `platform-overview-${check.level}` : 'platform-overview-missing'} aria-hidden="true"/></div>; })}</div>
      </section>
      <div className="platform-check-panel generic-platform-check">
        <div><strong>Bahnsteigdaten und Plausibilitätscheck</strong><span>OSM-Baulänge wird wie in Friedberg gegen die DB-Nettobaulänge geprüft; Anfang und Ende bleiben unabhängig prüfbar.</span></div>
        <div className="generic-check-actions"><div className="comparison-summary"><span className="comparison-low">{lengthComparisons.filter((item) => item.level === 'low').length} geringe</span><span className="comparison-check">{lengthComparisons.filter((item) => item.level === 'check').length} prüfen</span><span className="comparison-high">{lengthComparisons.filter((item) => item.level === 'high').length} auffällig</span></div><button type="button" className={reviewKey ? 'platform-check-switch platform-check-switch-on' : 'platform-check-switch'} onClick={startPlatformReview} disabled={!reviewEndpoints.length}><span aria-hidden="true"/>{aerialChecksRunning ? `Luftbildprüfung läuft (${Object.keys(aerialResults).length}/${platformEdges.length})` : reviewKey ? `Nächsten offenen Endpunkt prüfen (${reviewedEndpointCount}/${reviewEndpoints.length})` : 'Bahnsteigkanten prüfen'}</button></div>
      </div>
      <div className="generic-platform-scroll">
        <table className="platform-data-table">
          <thead><tr><th>Gleis</th><th>Bahnsteighöhe</th><th>Baulänge OSM</th><th>OSM-Daten bestätigt</th><th>Nettobaulänge DB</th><th>Abweichung OSM–DB</th><th>Gleisbezogene Bahnsteignutzlänge</th><th>Anfang Geokoordinaten</th><th>Ende Geokoordinaten</th></tr></thead>
          <tbody>{platformRows.map(({ track, edge, data }) => {
            const start = edge?.geometry[0], end = edge?.geometry.at(-1);
            const comparison = lengthComparison(edge, data);
            const plausibility = geometryPlausibility(edge);
            const confirmed = edge ? Boolean(osmConfirmed[edge.id]) : false;
            const dbNeedsReview = confirmed && comparison?.level === 'high';
            return <tr key={`${track}-${edge?.id ?? 'db'}`} className={comparison?.level === 'high' ? 'row-deviation-high' : undefined}><td><div className="data-value"><span className="track-pill">Gleis {track}</span>{edge?.trackSource === 'ref' ? <span>OSM ref={track} · {edge.osmType === 'way' ? 'Weg' : 'Knoten'} {edge.osmId}</span> : edge?.trackSource === 'local_ref' ? <span>OSM local_ref={track}</span> : null}</div></td><td><div className="data-value"><strong>{data?.platform_height_mm != null ? `${data.platform_height_mm} mm` : edge?.height ? `${Number(edge.height) * 1000} mm` : 'Nicht geliefert'}</strong><span>{data?.platform_height_mm != null ? 'DB InfraGO' : 'OpenStreetMap'}</span></div></td><td>{edge ? <div className="data-value"><strong>{edge.length.toFixed(1)} m</strong><span>OSM-Geometrie</span><div className={`osm-plausibility osm-plausibility-${plausibility.level}`}><strong>{plausibility.level === 'ok' ? 'OSM plausibel' : plausibility.level === 'check' ? 'OSM prüfen' : 'OSM auffällig'}</strong><span>{plausibility.reason}</span></div><a className="source-data-link" href={`https://www.openstreetmap.org/${edge.osmType}/${edge.osmId}`} target="_blank" rel="noreferrer">Original OSM {edge.osmType === 'way' ? 'Weg' : 'Knoten'} {edge.osmId}</a></div> : <span className="data-missing">Keine OSM-Kante zugeordnet</span>}</td><td>{edge ? <button type="button" className={confirmed ? 'osm-confirm osm-confirmed' : 'osm-confirm'} aria-pressed={confirmed} onClick={() => setOsmConfirmed((current) => ({ ...current, [edge.id]: !current[edge.id] }))}><ShieldCheck size={15}/>{confirmed ? 'Bestätigt' : 'Bestätigen'}</button> : <span className="data-missing">Nicht möglich</span>}</td><td>{data?.net_construction_length_m != null ? <div className={dbNeedsReview ? 'db-length-review' : 'data-value'}><strong>{data.net_construction_length_m.toFixed(1)} m</strong><span>DB InfraGO Stationsausstattung</span>{dbNeedsReview ? <span>DB-Nettobaulänge prüfen: bestätigte OSM-Länge weicht wesentlich ab</span> : null}</div> : <span className="data-missing">Bei DB InfraGO nicht geliefert</span>}</td><td>{comparison && edge ? <button type="button" className={`deviation deviation-${comparison.level} deviation-button`} onClick={() => focusPlatformLength(edge)} title="Bahnsteigkante im Luftbild anzeigen"><strong>OSM {Math.abs(comparison.delta).toFixed(1)} m {comparison.delta >= 0 ? 'länger' : 'kürzer'}</strong><span>als DB · {comparison.percent.toFixed(1)}% · {comparison.level === 'low' ? 'gering' : comparison.level === 'check' ? 'prüfen' : 'auffällig'}</span><span>Im Luftbild prüfen</span></button> : <span className="data-missing">Nicht vergleichbar</span>}</td><td>{data?.usable_length_m != null ? <div className="data-value"><strong>{data.usable_length_m.toFixed(1)} m</strong><span>RINF {data.rinf_platform_id || track}{data.rinf_platform_id && data.rinf_platform_id !== track ? ` → DB Gleis ${track}` : ''}</span>{data.rinf_track_id ? <span>Track-ID {data.rinf_track_id} · {data.mapping_confidence === 'confirmed' ? 'bestätigt' : data.mapping_confidence === 'derived' ? 'eindeutig abgeleitet' : 'nicht zugeordnet'}</span> : null}{data.net_construction_length_m != null && data.net_construction_length_m - data.usable_length_m > 0 && data.net_construction_length_m - data.usable_length_m < 5 ? <span className="automatic-check">Nur {(data.net_construction_length_m - data.usable_length_m).toFixed(1)} m kürzer als Nettobaulänge</span> : null}</div> : <span className="data-missing">In RINF nicht zugeordnet</span>}</td><td>{edge && start ? <button type="button" className="generic-endpoint-button" onClick={() => focusEndpoint(edge, 'start')}><strong>{start.lat.toFixed(6)}, {start.lon.toFixed(6)}</strong><span>Im Luftbild prüfen</span></button> : <span className="data-missing">Keine OSM-Koordinate</span>}</td><td>{edge && end ? <button type="button" className="generic-endpoint-button" onClick={() => focusEndpoint(edge, 'end')}><strong>{end.lat.toFixed(6)}, {end.lon.toFixed(6)}</strong><span>Im Luftbild prüfen</span></button> : <span className="data-missing">Keine OSM-Koordinate</span>}</td></tr>;
          })}{!loading && !platformRows.length ? <tr><td colSpan={9}><span className="data-missing">Keine Bahnsteigdaten in DB InfraGO, RINF oder OSM gefunden.</span></td></tr> : null}</tbody>
        </table>
      </div>
      <div className="platform-data-note"><ShieldCheck size={16}/><p>OSM-Geometrie, DB-Nettobaulänge und RINF-Nutzlänge bleiben getrennte Quellen. Bestätigungen und Endpunktkorrekturen werden je Station gespeichert; auffällige Werte werden nicht automatisch überschrieben.</p></div>
      <section className="object-catalog generic-object-catalog">
        <div className="catalog-toolbar"><div><h2>Objektkatalog</h2><p>Infrastruktur durchsuchen und Evidenz im Detail prüfen</p></div><div className="catalog-search"><Search size={17}/><input value={inventoryQuery} onChange={(event) => setInventoryQuery(event.target.value)} placeholder="Name, Gleis oder NeTEx-ID" aria-label="Objektkatalog durchsuchen"/></div></div>
        <div className="catalog-filters" aria-label="Objekttyp filtern">{[['all','Alle'],['platform','Bahnsteig'],['platform_edge','Bahnsteigkante'],['entrance','Zugang'],['equipment','Ausstattung']].map(([type, label]) => <button type="button" key={type} className={inventoryType === type ? 'active' : ''} onClick={() => setInventoryType(type)}>{label}{type !== 'all' ? <span>{inventoryCounts[type] ?? 0}</span> : null}</button>)}</div>
        <div className="catalog-body"><div className="object-list" role="list" aria-label={`${filteredInventory.length} gefundene Objekte`}><p className="catalog-result-count">{filteredInventory.length} Objekte</p>{filteredInventory.map((item) => <button role="listitem" type="button" key={item.object_key} onClick={() => setSelectedObjectKey(item.object_key)} className={selectedInventoryObject?.object_key === item.object_key ? 'object-row object-row-active' : 'object-row'} aria-current={selectedInventoryObject?.object_key === item.object_key ? 'true' : undefined}><span className={`type-dot type-${item.object_type}`}/><span><strong>{objectTitle(item)}</strong><small>{objectTypeLabels[item.object_type] ?? item.object_type} · {item.observations.length} Werte</small></span><span aria-hidden="true">›</span></button>)}{inventory === null ? <div className="catalog-empty">NeTEx-Infrastruktur wird geladen …</div> : !filteredInventory.length ? <div className="catalog-empty">Keine passenden Objekte gefunden</div> : null}</div>
        <div className="object-detail">{selectedInventoryObject ? <><span className="object-type-badge">{objectTypeLabels[selectedInventoryObject.object_type] ?? selectedInventoryObject.object_type}</span><h3>{objectTitle(selectedInventoryObject)}</h3><code>{selectedInventoryObject.object_key}</code><table><thead><tr><th>Attribut</th><th>Wert</th><th>Quelle</th></tr></thead><tbody>{selectedInventoryObject.observations.map((observation, index) => <tr key={`${observation.attribute}-${index}`}><td>{inventoryAttributeLabels[observation.attribute] ?? observation.attribute.replaceAll('_', ' ')}</td><td><strong>{displayInventoryValue(observation.value, observation.unit)}</strong></td><td><span className="evidence-source">DB OpenStation</span></td></tr>)}</tbody></table></> : <div className="catalog-empty">Objekt auswählen</div>}</div></div>
      </section>
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
    [stadaStations, setStaDaStations] = useState<StaDaStation[]>([]),
    [searching, setSearching] = useState(false),
    [showResults, setShowResults] = useState(false),
    [message, setMessage] = useState(
      'Friedberg (Hess) ist vollständig verfügbar; weitere Bahnhöfe können gesucht werden.',
    );
  const filteredStations = useMemo(() => {
    const tokens = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return stadaStations
      .filter((station) => {
        const haystack = normalizeSearch(`${station.name} ${station.station_number} ${station.eva ?? ''} ${station.ril ?? ''}`);
        return tokens.every((token) => haystack.includes(token));
      })
      .slice(0, 20);
  }, [query, stadaStations]);
  useEffect(() => {
    const controller = new AbortController();
    setSearching(true);
    void fetch(`${API}/stations/stada-list`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ stations: StaDaStation[] }>;
      })
      .then((data) => {
        setStaDaStations(data.stations);
        const mapped = data.stations.flatMap((candidate) => {
          const latitude = Number(candidate.latitude), longitude = Number(candidate.longitude);
          return Number.isFinite(latitude) && Number.isFinite(longitude) ? [{ id: `stada-${candidate.station_number}`, name: candidate.name, latitude, longitude }] : [];
        });
        setStations(mapped.length ? mapped : MAJOR);
        setMessage(`${mapped.length.toLocaleString('de-DE')} DB-Bahnhöfe werden auf der Karte angezeigt.`);
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError') setMessage('Die DB-Stationsliste konnte nicht geladen werden.');
      })
      .finally(() => setSearching(false));
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!el.current || map.current) return;
    void import('leaflet').then((L) => {
      if (!el.current || map.current) return;
      map.current = L.map(el.current, { minZoom: 5, maxZoom: 18, preferCanvas: true }).setView(
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
          radius: 5,
          color: '#fff',
          weight: 2,
          fillColor: '#0b6b8a',
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
          setMessage(`${s.name}: Stationsansicht wird geöffnet.`);
        });
      });
    });
  }, [onSelect, stations]);
  const chooseStation = (candidate: StaDaStation) => {
    const latitude = Number(candidate.latitude), longitude = Number(candidate.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setMessage(`${candidate.name} hat in StaDa keine Kartenkoordinaten.`);
      return;
    }
    const station: Station = { id: `stada-${candidate.station_number}`, name: candidate.name, latitude, longitude };
    setShowResults(false);
    map.current?.setView([latitude, longitude], 16, { animate: true });
    onSelect(station);
    setMessage(`${candidate.name} wird in der Kartenansicht angezeigt.`);
  };
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    if (filteredStations[0]) chooseStation(filteredStations[0]);
    else if (query.trim()) setMessage('Kein DB-Bahnhof gefunden.');
  };
  return (
    <section className="germany-map-card">
      <div className="germany-map-copy">
        <div>
          <p className="map-kicker">BAHNHOF AUSWÄHLEN</p>
          <h2>Deutschlandweite Bahnhofssuche</h2>
          <p>DB-Bahnhof eingeben; die StaDa-Liste wird mit jedem Buchstaben eingegrenzt.</p>
        </div>
        <div className="station-picker">
          <form onSubmit={search}>
            <Search size={17} />
            <input value={query} onFocus={() => setShowResults(Boolean(query.trim()))} onChange={(e) => { setQuery(e.target.value); setShowResults(Boolean(e.target.value.trim())); }} placeholder="DB-Bahnhof suchen, z. B. Kassel" autoComplete="off" />
            <button disabled={searching || !filteredStations.length}>{searching ? 'Lade …' : 'Auswählen'}</button>
          </form>
          {showResults ? <div className="station-picker-results" role="listbox" aria-label="DB-Stationsliste">{filteredStations.length ? filteredStations.map((station) => <button type="button" role="option" key={station.station_number} onClick={() => chooseStation(station)}><TrainFront size={15}/><span>{station.name}</span><small>StaDa {station.station_number}{station.ril ? ` · ${station.ril}` : ''}</small></button>) : <div className="station-picker-empty">Kein DB-Bahnhof gefunden</div>}</div> : null}
        </div>
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
