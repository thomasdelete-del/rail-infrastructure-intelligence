'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Layers3,
  MapPin,
  RefreshCw,
  Satellite,
  Search,
  ShieldCheck,
  TrainFront,
} from 'lucide-react';
import type { Map as LeafletMap, LayerGroup, TileLayer } from 'leaflet';
const API =
  'https://rail-infrastructure-intelligence-production.up.railway.app';
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
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de');
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
  mapping_score?: number | null;
  mapping_evidence?: string[] | null;
};
type InventoryObservation = {
  attribute: string;
  value: unknown;
  unit?: string | null;
  source_key: string;
  provenance?: Record<string, unknown>;
};
type InventoryObject = {
  object_key: string;
  object_type: string;
  parent_object_key?: string | null;
  depth: number;
  observations: InventoryObservation[];
};
type StationInventory = {
  station: string;
  object_count: number;
  objects: InventoryObject[];
};
type AerialFeatures = Record<string, number | boolean>;
type GenericAerialAnalysis = {
  status: 'plausible' | 'check' | 'high' | 'insufficient_evidence';
  confidence: number;
  candidate_start?: { latitude: number; longitude: number };
  candidate_end?: { latitude: number; longitude: number };
  candidate_length_m?: number;
  maximum_endpoint_shift_m?: number;
  start_shift_m?: number;
  end_shift_m?: number;
  start_features?: AerialFeatures;
  end_features?: AerialFeatures;
  start_learned_probability?: number | null;
  end_learned_probability?: number | null;
  training_sample_count?: number;
  reason?: string;
};
const objectTypeLabels: Record<string, string> = {
  stop_place: 'Bahnhof',
  platform: 'Bahnsteig',
  platform_edge: 'Bahnsteigkante',
  entrance: 'Zugang',
  equipment: 'Ausstattung',
};
const inventoryAttributeLabels: Record<string, string> = {
  name: 'Bezeichnung',
  public_code: 'Gleis',
  quay_type: 'Bahnsteigtyp',
  mobility_impaired_access: 'Barrierefreiheit',
  wheelchair_access: 'Rollstuhlzugang',
  step_free_access: 'Stufenfreier Zugang',
  tactile_guidance_available: 'Taktiles Leitsystem',
  visual_signs_available: 'Visuelle Anzeigen',
  equipment_type: 'Ausstattungstyp',
  number_of_steps: 'Stufen',
  safe_for_guide_dog: 'Für Blindenführhund geeignet',
  latitude: 'Breitengrad',
  longitude: 'Längengrad',
  station_number: 'Stationsnummer',
  eva: 'EVA',
  ril: 'RIL 100',
};

const distance = (
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
) => {
  const radians = (value: number) => (value * Math.PI) / 180;
  const lat1 = radians(a.lat),
    lat2 = radians(b.lat);
  const dLat = lat2 - lat1,
    dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

const geometryLength = (geometry: Array<{ lat: number; lon: number }>) =>
  geometry
    .slice(1)
    .reduce((sum, point, index) => sum + distance(geometry[index], point), 0);

const lateralDistanceToGeometry = (
  point: { lat: number; lon: number },
  geometry: Array<{ lat: number; lon: number }>,
) => {
  const latitudeScale = 111_320;
  const longitudeScale = latitudeScale * Math.cos((point.lat * Math.PI) / 180);
  return geometry.slice(1).reduce((nearest, end, index) => {
    const start = geometry[index];
    const segmentX = (end.lon - start.lon) * longitudeScale;
    const segmentY = (end.lat - start.lat) * latitudeScale;
    const pointX = (point.lon - start.lon) * longitudeScale;
    const pointY = (point.lat - start.lat) * latitudeScale;
    const segmentLength = Math.hypot(segmentX, segmentY);
    if (!segmentLength) return nearest;
    return Math.min(
      nearest,
      Math.abs(segmentX * pointY - segmentY * pointX) / segmentLength,
    );
  }, Number.POSITIVE_INFINITY);
};

const belongsToPlatformSide = (
  point: { lat: number; lon: number },
  target: PlatformEdge,
  edges: PlatformEdge[],
) => {
  const targetDistance = lateralDistanceToGeometry(point, target.geometry);
  if (targetDistance > 12) return false;
  const nearestOtherDistance = Math.min(
    ...edges
      .filter((edge) => edge.id !== target.id)
      .map((edge) => lateralDistanceToGeometry(point, edge.geometry)),
  );
  return (
    !Number.isFinite(nearestOtherDistance) ||
    targetDistance + 0.75 < nearestOtherDistance
  );
};

const platformAxis = (geometry: Array<{ lat: number; lon: number }>) => {
  let best:
    | [{ lat: number; lon: number }, { lat: number; lon: number }, number]
    | null = null;
  geometry.forEach((start, startIndex) =>
    geometry.slice(startIndex + 1).forEach((end) => {
      const length = distance(start, end);
      if (!best || length > best[2]) best = [start, end, length];
    }),
  );
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
  const reviewLayerRef = useRef<LayerGroup | null>(null);
  const originalGeometriesRef = useRef<
    Record<string, Array<{ lat: number; lon: number }>>
  >({});
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
  const [dbSources, setDbSources] = useState<{
    netex?: string;
    rinf?: string;
    osm?: string;
    stada?: string;
    fasta?: string;
    facilities?: number;
  }>({});
  const [platformEdges, setPlatformEdges] = useState<PlatformEdge[]>([]);
  const [authoritativePlatforms, setAuthoritativePlatforms] = useState<
    AuthoritativePlatform[]
  >([]);
  const [inventory, setInventory] = useState<StationInventory | null>(null);
  const [inventoryQuery, setInventoryQuery] = useState('');
  const [inventoryType, setInventoryType] = useState('all');
  const [selectedObjectKey, setSelectedObjectKey] = useState<string | null>(
    null,
  );
  const [imagery, setImagery] = useState<'none' | 'satellite' | 'official'>(
    'none',
  );
  const [imageryOpacity, setImageryOpacity] = useState(82);
  const [loading, setLoading] = useState(true);
  const [osmGeometryStatus, setOsmGeometryStatus] = useState<
    'loading' | 'active' | 'unavailable'
  >('loading');
  const [osmBaseMapStatus, setOsmBaseMapStatus] = useState<
    'loading' | 'active' | 'unavailable'
  >('loading');
  const [satelliteStatus, setSatelliteStatus] = useState<
    'loading' | 'active' | 'unavailable'
  >('loading');
  const [officialImageryStatus, setOfficialImageryStatus] = useState<
    'loading' | 'active' | 'unavailable'
  >('loading');
  const [sourceUpdated, setSourceUpdated] = useState<Record<string, Date>>({});
  const [databaseFreshness, setDatabaseFreshness] = useState<{
    lastUpdate?: string;
    sources: Record<
      string,
      { sourceDate?: string; retrievalDate?: string; databaseUpdate?: string }
    >;
  }>({ sources: {} });
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [endpointReviews, setEndpointReviews] = useState<
    Record<string, 'correct' | 'none' | 'corrected'>
  >({});
  const [osmConfirmed, setOsmConfirmed] = useState<Record<string, boolean>>({});
  const [aerialResults, setAerialResults] = useState<
    Record<string, GenericAerialAnalysis>
  >({});
  const [aerialChecksRunning, setAerialChecksRunning] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState<{
    edgeId: string;
    endpoint: 'start' | 'end';
    track: string;
  } | null>(null);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [correctedGeometries, setCorrectedGeometries] = useState<
    Record<string, Array<{ lat: number; lon: number }>>
  >({});
  const [learningMessage, setLearningMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const authoritativeName = identity?.name || station.name;
  const displayName = /bahnhof$/i.test(authoritativeName.trim())
    ? authoritativeName
    : `${authoritativeName} Bahnhof`;
  const officialImageryAvailable =
    station.latitude >= 49.39 &&
    station.latitude <= 51.66 &&
    station.longitude >= 7.77 &&
    station.longitude <= 10.24;
  useEffect(() => {
    try {
      setOsmConfirmed(
        JSON.parse(
          localStorage.getItem(`station-osm-confirmed:${station.id}`) || '{}',
        ),
      );
      setEndpointReviews(
        JSON.parse(
          localStorage.getItem(`station-endpoint-reviews:${station.id}`) ||
            '{}',
        ),
      );
      setCorrectedGeometries(
        JSON.parse(
          localStorage.getItem(`station-coordinate-drafts:${station.id}`) ||
            '{}',
        ),
      );
    } catch {
      setOsmConfirmed({});
      setEndpointReviews({});
      setCorrectedGeometries({});
    }
  }, [station.id]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API}/sources/freshness`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error()),
      )
      .then((raw: unknown) => {
        const data = raw as {
          last_database_update?: string | null;
          sources?: Array<{
            source_key: string;
            source_date?: string | null;
            retrieval_date?: string | null;
            last_database_update?: string | null;
          }>;
        };
        setDatabaseFreshness({
          lastUpdate: data.last_database_update ?? undefined,
          sources: Object.fromEntries(
            (data.sources ?? []).map((source) => [
              source.source_key,
              {
                sourceDate: source.source_date ?? undefined,
                retrievalDate: source.retrieval_date ?? undefined,
                databaseUpdate: source.last_database_update ?? undefined,
              },
            ]),
          ),
        });
      })
      .catch(() => setDatabaseFreshness({ sources: {} }));
    return () => controller.abort();
  }, [refreshNonce]);
  useEffect(() => {
    localStorage.setItem(
      `station-osm-confirmed:${station.id}`,
      JSON.stringify(osmConfirmed),
    );
  }, [osmConfirmed, station.id]);
  useEffect(() => {
    localStorage.setItem(
      `station-endpoint-reviews:${station.id}`,
      JSON.stringify(endpointReviews),
    );
  }, [endpointReviews, station.id]);
  useEffect(() => {
    localStorage.setItem(
      `station-coordinate-drafts:${station.id}`,
      JSON.stringify(correctedGeometries),
    );
  }, [correctedGeometries, station.id]);
  const focusEndpoint = (edge: PlatformEdge, endpoint: 'start' | 'end') => {
    const point =
      endpoint === 'start' ? edge.geometry[0] : edge.geometry.at(-1);
    setCorrectionError(null);
    setReviewKey(`${edge.id}:${endpoint}`);
    setImagery(officialImageryStatus === 'active' ? 'official' : 'satellite');
    if (point)
      mapRef.current?.setView([point.lat, point.lon], 21, { animate: false });
    requestAnimationFrame(() =>
      el.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
  };
  const focusPlatformLength = (edge: PlatformEdge) => {
    setReviewKey(null);
    setImagery(officialImageryStatus === 'active' ? 'official' : 'satellite');
    if (!edge.geometry.length) return;
    mapRef.current?.fitBounds(
      edge.geometry.map((point) => [point.lat, point.lon] as [number, number]),
      { padding: [70, 70], maxZoom: 19, animate: false },
    );
    requestAnimationFrame(() =>
      el.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
  };
  useEffect(() => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const reviewedTarget = reviewKey
      ? platformEdges.flatMap((edge) =>
          (['start', 'end'] as const)
            .filter((endpoint) => `${edge.id}:${endpoint}` === reviewKey)
            .map((endpoint) => ({
              edgeId: edge.id,
              endpoint,
              track: edge.track,
            })),
        )[0]
      : undefined;
    const applyCoordinate = (
      event: { latlng: { lat: number; lng: number } },
      target: { edgeId: string; endpoint: 'start' | 'end'; track: string },
    ) => {
      const coordinate = { lat: event.latlng.lat, lon: event.latlng.lng };
      const targetEdge = platformEdges.find(
        (edge) => edge.id === target.edgeId,
      );
      if (
        !targetEdge ||
        !belongsToPlatformSide(coordinate, targetEdge, platformEdges)
      ) {
        setCorrectionError(
          `Punkt liegt nicht eindeutig auf der Bahnsteigkante von Gleis ${target.track}.`,
        );
        return;
      }
      setCorrectionError(null);
      setPlatformEdges((current) =>
        current.map((edge) => {
          if (edge.id !== target.edgeId) return edge;
          const geometry = [...edge.geometry];
          if (target.endpoint === 'start') geometry[0] = coordinate;
          else geometry[geometry.length - 1] = coordinate;
          setCorrectedGeometries((drafts) => ({
            ...drafts,
            [edge.id]: geometry,
          }));
          return { ...edge, geometry, length: geometryLength(geometry) };
        }),
      );
      const key = `${target.edgeId}:${target.endpoint}`;
      setEndpointReviews((current) => ({ ...current, [key]: 'corrected' }));
      const analysis = aerialResults[target.edgeId];
      const features =
        target.endpoint === 'start'
          ? analysis?.start_features
          : analysis?.end_features;
      setLearningMessage('Korrektur wird als Lernbeispiel gespeichert …');
      void fetch(`${API}/stations/aerial-analysis/training-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          track: `${authoritativeName}:${target.track}`,
          endpoint: target.endpoint,
          accepted: false,
          features: features ?? {},
          corrected_coordinate: {
            latitude: coordinate.lat,
            longitude: coordinate.lon,
          },
        }),
      })
        .then((response) => {
          if (!response.ok) throw new Error();
          setLearningMessage(
            'Korrektur gespeichert – die Erkennung lernt aus diesem Beispiel.',
          );
        })
        .catch(() =>
          setLearningMessage(
            'Korrektur lokal gespeichert; Lernserver derzeit nicht erreichbar.',
          ),
        );
      setCorrectionTarget(null);
    };
    const handleClick = (event: { latlng: { lat: number; lng: number } }) => {
      if (correctionTarget) applyCoordinate(event, correctionTarget);
    };
    const handleDoubleClick = (event: {
      latlng: { lat: number; lng: number };
      originalEvent?: MouseEvent;
    }) => {
      const target = correctionTarget ?? reviewedTarget;
      if (!target) return;
      event.originalEvent?.preventDefault();
      applyCoordinate(event, target);
    };
    map.on('click', handleClick);
    map.on('dblclick', handleDoubleClick);
    return () => {
      map.off('click', handleClick);
      map.off('dblclick', handleDoubleClick);
    };
  }, [
    aerialResults,
    authoritativeName,
    correctionTarget,
    platformEdges,
    reviewKey,
  ]);
  useEffect(() => {
    setIdentity(null);
    setDbSources({});
    setAuthoritativePlatforms([]);
    setInventory(null);
    setSelectedObjectKey(null);
    setAerialResults({});
    setAerialChecksRunning(false);
    setLoadError(null);
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      name: station.name,
      latitude: String(station.latitude),
      longitude: String(station.longitude),
    });
    void fetch(`${API}/stations/dynamic-sources?${parameters}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error()),
      )
      .then(async (raw: unknown) => {
        const bundle = raw as {
          identity: {
            matched_name?: string;
            eva?: string;
            ril?: string;
            station_number?: string;
            osm_type?: string;
            osm_id?: number;
          };
          sources?: {
            netex?: { status?: string };
            era_rinf?: { status?: string };
            openstreetmap?: { status?: string };
            stada?: { status?: string };
            fasta?: { status?: string; facility_count?: number };
          };
        };
        const value = bundle.identity;
        const fetchedAt = new Date();
        setIdentity({
          name: value.matched_name,
          eva: value.eva,
          ril: value.ril,
          stationNumber: value.station_number,
          osm:
            value.osm_type && value.osm_id
              ? `${value.osm_type}/${value.osm_id}`
              : undefined,
        });
        setDbSources({
          netex: bundle.sources?.netex?.status,
          rinf: bundle.sources?.era_rinf?.status,
          osm: bundle.sources?.openstreetmap?.status,
          stada: bundle.sources?.stada?.status,
          fasta: bundle.sources?.fasta?.status,
          facilities: bundle.sources?.fasta?.facility_count,
        });
        setSourceUpdated((current) => ({
          ...current,
          stada: fetchedAt,
          netex: fetchedAt,
          rinf: fetchedAt,
          fasta: fetchedAt,
        }));
        if (value.ril) {
          const platformParameters = new URLSearchParams({
            name: value.matched_name || station.name,
            ril: value.ril,
          });
          const response = await fetch(
            `${API}/stations/platform-data?${platformParameters}`,
            { cache: 'no-store', signal: controller.signal },
          );
          if (response.ok) {
            const data = (await response.json()) as {
              platforms: AuthoritativePlatform[];
              status: { db_infrago?: string; era_rinf?: string };
            };
            let platforms = data.platforms;
            if (platforms.some((item) => item.usable_length_m != null))
              localStorage.setItem(
                `station-platform-reference:${station.id}`,
                JSON.stringify(platforms),
              );
            else {
              try {
                const cached = JSON.parse(
                  localStorage.getItem(
                    `station-platform-reference:${station.id}`,
                  ) || '[]',
                ) as AuthoritativePlatform[];
                if (cached.length) {
                  platforms = data.platforms.map((item) => ({
                    ...cached.find((entry) => entry.track === item.track),
                    ...item,
                    usable_length_m:
                      item.usable_length_m ??
                      cached.find((entry) => entry.track === item.track)
                        ?.usable_length_m,
                    rinf_platform_id:
                      item.rinf_platform_id ??
                      cached.find((entry) => entry.track === item.track)
                        ?.rinf_platform_id,
                    rinf_track_id:
                      item.rinf_track_id ??
                      cached.find((entry) => entry.track === item.track)
                        ?.rinf_track_id,
                    mapping_method: item.mapping_method ?? 'cached_reference',
                    mapping_confidence: item.mapping_confidence ?? 'confirmed',
                    mapping_evidence: item.mapping_evidence?.length
                      ? item.mapping_evidence
                      : ['last_successful_station_reference'],
                  }));
                  data.status.era_rinf = 'cached';
                }
              } catch {}
            }
            setAuthoritativePlatforms(platforms);
            setDbSources((current) => ({
              ...current,
              rinf: data.status.era_rinf,
            }));
            setSourceUpdated((current) => ({ ...current, rinf: new Date() }));
          }
        }
      })
      .then(() => setLastUpdated(new Date()))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') {
          setIdentity(null);
          setDbSources({
            stada: 'unavailable',
            netex: 'unavailable',
            rinf: 'unavailable',
            osm: 'unavailable',
            fasta: 'unavailable',
          });
          setLoadError(
            'Die Stationsstammdaten konnten nicht vollständig geladen werden.',
          );
        }
      });
    return () => controller.abort();
  }, [station, refreshNonce]);
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      name: station.name,
      latitude: String(station.latitude),
      longitude: String(station.longitude),
    });
    void fetch(`${API}/stations/infrastructure?${parameters}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error()),
      )
      .then((raw: unknown) => {
        const data = raw as StationInventory;
        setInventory(data);
        setSelectedObjectKey(data.objects[0]?.object_key ?? null);
      })
      .catch((error: Error) => {
        if (error.name !== 'AbortError') {
          setInventory({ station: station.name, object_count: 0, objects: [] });
          setLoadError(
            (current) =>
              current ?? 'Die NeTEx-Infrastruktur konnte nicht geladen werden.',
          );
        }
      });
    return () => controller.abort();
  }, [station, refreshNonce]);
  useEffect(() => {
    if (!el.current) return;
    setLoading(true);
    setOsmGeometryStatus('loading');
    setOsmBaseMapStatus('loading');
    setSatelliteStatus('loading');
    setOfficialImageryStatus(
      officialImageryAvailable ? 'loading' : 'unavailable',
    );
    setCounts({ platforms: 0, entrances: 0, equipment: 0 });
    setPlatformEdges([]);
    setImagery('none');
    let disposed = false;
    let instance: LeafletMap | null = null;
    void import('leaflet').then(async (L) => {
      if (disposed || !el.current) return;
      instance = L.map(el.current, {
        minZoom: 5,
        maxZoom: 24,
        doubleClickZoom: false,
      }).setView([station.latitude, station.longitude], 17);
      const osmBaseLayer = L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          maxNativeZoom: 19,
          maxZoom: 24,
          attribution: '&copy; OpenStreetMap-Mitwirkende',
        },
      );
      osmBaseLayer.on('load', () => {
        if (!disposed) {
          setOsmBaseMapStatus('active');
          setSourceUpdated((current) => ({ ...current, osm: new Date() }));
        }
      });
      osmBaseLayer.on('tileerror', () => {
        if (!disposed)
          setOsmBaseMapStatus((current) =>
            current === 'active' ? current : 'unavailable',
          );
      });
      osmBaseLayer.addTo(instance);
      mapRef.current = instance;
      reviewLayerRef.current = L.layerGroup().addTo(instance);
      satelliteRef.current = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          maxNativeZoom: 19,
          maxZoom: 24,
          opacity: 0,
          attribution:
            'Satellitenbild &copy; Esri, Maxar, Earthstar Geographics und weitere',
        },
      ).addTo(instance);
      satelliteRef.current.on('load', () => {
        if (!disposed) {
          setSatelliteStatus('active');
          setSourceUpdated((current) => ({
            ...current,
            satellite: new Date(),
          }));
        }
      });
      satelliteRef.current.on('tileerror', () => {
        if (!disposed)
          setSatelliteStatus((current) =>
            current === 'active' ? current : 'unavailable',
          );
      });
      if (officialImageryAvailable) {
        officialRef.current = L.tileLayer.wms(
          'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows',
          {
            layers: 'he_dop20_rgb',
            format: 'image/png',
            transparent: true,
            version: '1.1.1',
            maxZoom: 24,
            opacity: 0,
            attribution:
              'Luftbild: &copy; Hessische Verwaltung für Bodenmanagement und Geoinformation · DL-DE Zero-2.0',
          },
        );
        officialRef.current.on('load', () => {
          if (!disposed) {
            setOfficialImageryStatus('active');
            setSourceUpdated((current) => ({
              ...current,
              official: new Date(),
            }));
          }
        });
        officialRef.current.on('tileerror', () => {
          if (disposed) return;
          setOfficialImageryStatus((current) =>
            current === 'active' ? current : 'unavailable',
          );
          setImagery((current) =>
            current === 'official' ? 'satellite' : current,
          );
        });
        officialRef.current.addTo(instance);
      }
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
        const parameters = new URLSearchParams({
          latitude: String(station.latitude),
          longitude: String(station.longitude),
        });
        const response = await fetch(
          `${API}/stations/osm-platforms?${parameters}`,
          { cache: 'no-store' },
        );
        if (!response.ok) throw new Error();
        const data = (await response.json()) as {
          elements: OsmElement[];
          cache_used?: boolean;
        };
        if (disposed) return;
        if (data.elements.length)
          localStorage.setItem(
            `station-osm-reference:${station.id}`,
            JSON.stringify(data.elements),
          );
        else {
          try {
            data.elements = JSON.parse(
              localStorage.getItem(`station-osm-reference:${station.id}`) ||
                '[]',
            ) as OsmElement[];
            if (data.elements.length) {
              data.cache_used = true;
              setDbSources((current) => ({ ...current, osm: 'cached' }));
            }
          } catch {}
        }
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
            tags.railway === 'platform' ||
            tags.railway === 'platform_edge' ||
            tags.public_transport === 'platform';
          const isPlatformEdge = tags.railway === 'platform_edge';
          const isStation = ['station', 'halt'].includes(tags.railway ?? '');
          const isEntrance =
            tags.railway === 'subway_entrance' || Boolean(tags.entrance);
          if (isStation) return;
          if (isEntrance) entrances++;
          else if (!isPlatform) equipment++;
          if (item.geometry?.length && isPlatformEdge) {
            const edge = {
              id: `${item.type}-${item.id}`,
              track: tags.ref || tags.local_ref || 'ohne Nummer',
              trackSource: tags.ref
                ? ('ref' as const)
                : tags.local_ref
                  ? ('local_ref' as const)
                  : ('unknown' as const),
              osmType: item.type,
              osmId: item.id,
              geometry: item.geometry,
              length: geometryLength(item.geometry),
              height: tags.height,
            };
            explicitEdges.push(edge);
          } else if (item.geometry?.length && isPlatform) {
            L.polyline(
              item.geometry.map((p) => [p.lat, p.lon] as [number, number]),
              { color: '#0b5278', weight: 3, opacity: 0.55 },
            ).addTo(instance!);
            const axis = platformAxis(item.geometry);
            if (
              axis &&
              axis[2] >= 40 &&
              (tags.railway === 'platform' ||
                tags.public_transport === 'platform')
            )
              platformCandidates.push({
                id: `${item.type}-${item.id}`,
                track: tags.ref || tags.local_ref || '',
                trackSource: tags.ref
                  ? 'ref'
                  : tags.local_ref
                    ? 'local_ref'
                    : 'unknown',
                osmType: item.type,
                osmId: item.id,
                geometry: [axis[0], axis[1]],
                length: axis[2],
                height: tags.height,
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
        const explicitTracks = new Set(
          explicitEdges
            .map((edge) => edge.track)
            .filter((track) => track && track !== 'ohne Nummer'),
        );
        platformCandidates.forEach((candidate) => {
          if (
            (candidate.track && !explicitTracks.has(candidate.track)) ||
            (!candidate.track && !explicitEdges.length)
          )
            edges.push(candidate);
        });
        if (edges.length === 1 && !edges[0].track) {
          edges[0].track = '1';
          edges[0].trackSource = 'single_platform_fallback';
        }
        edges.forEach((edge) => {
          L.polyline(
            edge.geometry.map(
              (point) => [point.lat, point.lon] as [number, number],
            ),
            { color: '#00a6c7', weight: 5, opacity: 0.9 },
          ).addTo(instance!);
          L.polyline(
            edge.geometry.map(
              (point) => [point.lat, point.lon] as [number, number],
            ),
            { color: '#00a6c7', weight: 18, opacity: 0 },
          )
            .bindTooltip(`Gleis ${escapeHtml(edge.track || 'ohne Nummer')}`, {
              sticky: true,
              direction: 'top',
              className: 'track-hover-tooltip',
            })
            .addTo(instance!);
          const start = edge.geometry[0],
            end = edge.geometry.at(-1)!;
          L.circleMarker([start.lat, start.lon], {
            radius: 5,
            color: '#fff',
            weight: 2,
            fillColor: '#20a464',
            fillOpacity: 1,
          }).addTo(instance!);
          L.circleMarker([end.lat, end.lon], {
            radius: 5,
            color: '#fff',
            weight: 2,
            fillColor: '#d54532',
            fillOpacity: 1,
          }).addTo(instance!);
        });
        setCounts({ platforms: edges.length, entrances, equipment });
        edges.forEach((edge) => {
          originalGeometriesRef.current[edge.id] = edge.geometry;
        });
        setPlatformEdges(
          edges
            .map((edge) => {
              const draft = correctedGeometries[edge.id];
              return draft?.length >= 2
                ? { ...edge, geometry: draft, length: geometryLength(draft) }
                : edge;
            })
            .sort((a, b) =>
              a.track.localeCompare(b.track, 'de', { numeric: true }),
            ),
        );
      } catch {
        if (!disposed) {
          setCounts({ platforms: 0, entrances: 0, equipment: 0 });
          setOsmGeometryStatus('unavailable');
          setLoadError(
            (current) =>
              current ??
              'Die OSM-Infrastrukturgeometrie konnte nicht geladen werden.',
          );
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    });
    return () => {
      disposed = true;
      instance?.remove();
      mapRef.current = null;
      reviewLayerRef.current = null;
      satelliteRef.current = null;
      officialRef.current = null;
    };
  }, [
    correctedGeometries,
    displayName,
    officialImageryAvailable,
    refreshNonce,
    station,
  ]);
  useEffect(() => {
    const opacity = imageryOpacity / 100;
    satelliteRef.current?.setOpacity(imagery === 'satellite' ? opacity : 0);
    officialRef.current?.setOpacity(imagery === 'official' ? opacity : 0);
  }, [imagery, imageryOpacity]);
  const platformRows = useMemo(() => {
    const matched = new Set<string>();
    const rows: Array<{
      track: string;
      edge?: PlatformEdge;
      data?: AuthoritativePlatform;
    }> = authoritativePlatforms.map((data) => {
      const edge = platformEdges.find(
        (candidate) => candidate.track === data.track,
      );
      if (edge) matched.add(edge.id);
      return { track: data.track, edge, data };
    });
    platformEdges
      .filter((edge) => !matched.has(edge.id))
      .forEach((edge) =>
        rows.push({ track: edge.track, edge, data: undefined }),
      );
    return rows.sort((a, b) =>
      a.track.localeCompare(b.track, 'de', { numeric: true }),
    );
  }, [authoritativePlatforms, platformEdges]);
  const lengthComparison = (
    edge?: PlatformEdge,
    data?: AuthoritativePlatform,
  ) => {
    const dbLength = data?.net_construction_length_m;
    if (!edge || dbLength == null || dbLength <= 0) return null;
    const delta = edge.length - dbLength;
    const percent = (Math.abs(delta) / dbLength) * 100;
    return {
      delta,
      percent,
      level: percent <= 5 ? 'low' : percent <= 15 ? 'check' : 'high',
    } as const;
  };
  const geometryPlausibility = (edge?: PlatformEdge) => {
    if (!edge || edge.geometry.length < 2 || edge.length <= 0)
      return {
        level: 'high' as const,
        reason: 'Endpunkte oder Linienlänge fehlen',
      };
    const direct = distance(edge.geometry[0], edge.geometry.at(-1)!);
    const straightness = direct / edge.length;
    if (edge.length < 80)
      return {
        level: 'high' as const,
        reason: 'OSM-Bahnsteigkante ungewöhnlich kurz',
      };
    if (straightness < 0.9 || straightness > 1.02)
      return {
        level: 'check' as const,
        reason: 'Linienlänge und Endpunktdistanz sind nicht stimmig',
      };
    return { level: 'ok' as const, reason: 'OSM-Geometrie intern plausibel' };
  };
  const lengthComparisons = platformRows
    .map(({ edge, data }) => lengthComparison(edge, data))
    .filter((item) => item !== null);
  const reviewEndpoints = useMemo(
    () =>
      platformEdges.flatMap((edge) => [
        { edge, endpoint: 'start' as const, key: `${edge.id}:start` },
        { edge, endpoint: 'end' as const, key: `${edge.id}:end` },
      ]),
    [platformEdges],
  );
  const reviewIndex = Math.max(
    0,
    reviewEndpoints.findIndex((item) => item.key === reviewKey),
  );
  const currentReview = reviewKey ? reviewEndpoints[reviewIndex] : null;
  const currentAerial = currentReview
    ? aerialResults[currentReview.edge.id]
    : undefined;
  useEffect(() => {
    const layer = reviewLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!currentReview) return;
    let disposed = false;
    void import('leaflet').then((L) => {
      if (disposed || !reviewLayerRef.current) return;
      const target = reviewLayerRef.current;
      const geometry = currentReview.edge.geometry;
      if (geometry.length >= 2) {
        L.polyline(
          geometry.map((point) => [point.lat, point.lon] as [number, number]),
          { color: '#f5a623', weight: 7, opacity: 0.95 },
        )
          .bindTooltip(
            `Geprüfte Bahnsteigkante · Gleis ${escapeHtml(currentReview.edge.track)}`,
          )
          .addTo(target);
        const start = geometry[0],
          end = geometry.at(-1)!;
        const endpointMarker = (
          endpoint: 'start' | 'end',
          point: { lat: number; lon: number },
        ) => {
          const status =
            endpointReviews[`${currentReview.edge.id}:${endpoint}`];
          const baseColor = endpoint === 'start' ? '#20a464' : '#d54532';
          const label = endpoint === 'start' ? 'Anfang' : 'Ende';
          if (status === 'corrected') {
            L.marker([point.lat, point.lon], {
              icon: L.divIcon({
                className: 'corrected-endpoint-icon',
                html: '<span aria-hidden="true"></span>',
                iconSize: [22, 22],
                iconAnchor: [11, 11],
              }),
            })
              .bindTooltip(`${label}: richtiger Abschluss gesetzt`)
              .addTo(target);
          } else if (status === 'correct') {
            L.circleMarker([point.lat, point.lon], {
              radius: 9,
              color: '#fff',
              weight: 3,
              fillColor: '#20845a',
              fillOpacity: 1,
            })
              .bindTooltip(`${label}: bestätigt`)
              .addTo(target);
          } else if (status === 'none') {
            L.circleMarker([point.lat, point.lon], {
              radius: 10,
              color: '#c23b30',
              weight: 4,
              fillColor: '#fff',
              fillOpacity: 0.75,
              dashArray: '3 3',
            })
              .bindTooltip(`${label}: kein Abschluss – Korrektur offen`)
              .addTo(target);
          } else {
            L.circleMarker([point.lat, point.lon], {
              radius: 8,
              color: '#fff',
              weight: 3,
              fillColor: baseColor,
              fillOpacity: 1,
            })
              .bindTooltip(`Geprüfter ${label}`)
              .addTo(target);
          }
        };
        endpointMarker('start', start);
        endpointMarker('end', end);
      }
      if (!currentAerial?.candidate_start || !currentAerial.candidate_end)
        return;
      const candidateStart = [
        currentAerial.candidate_start.latitude,
        currentAerial.candidate_start.longitude,
      ] as [number, number];
      const candidateEnd = [
        currentAerial.candidate_end.latitude,
        currentAerial.candidate_end.longitude,
      ] as [number, number];
      L.polyline([candidateStart, candidateEnd], {
        color: '#00c7df',
        weight: 5,
        opacity: 0.95,
        dashArray: '10 7',
      })
        .bindTooltip(
          `Luftbild-Erkennung${currentAerial.candidate_length_m != null ? ` · ${currentAerial.candidate_length_m.toFixed(1)} m` : ''}`,
        )
        .addTo(target);
      L.circleMarker(candidateStart, {
        radius: 9,
        color: '#063b55',
        weight: 3,
        fillColor: '#00d4e8',
        fillOpacity: 1,
      })
        .bindTooltip('Erkannter Anfang im Luftbild')
        .addTo(target);
      L.circleMarker(candidateEnd, {
        radius: 9,
        color: '#063b55',
        weight: 3,
        fillColor: '#00d4e8',
        fillOpacity: 1,
      })
        .bindTooltip('Erkanntes Ende im Luftbild')
        .addTo(target);
      const currentPoint =
        currentReview.endpoint === 'start' ? geometry[0] : geometry.at(-1);
      const candidatePoint =
        currentReview.endpoint === 'start' ? candidateStart : candidateEnd;
      const shift =
        currentReview.endpoint === 'start'
          ? currentAerial.start_shift_m
          : currentAerial.end_shift_m;
      if (currentPoint)
        L.polyline([[currentPoint.lat, currentPoint.lon], candidatePoint], {
          color: shift != null && shift <= 2 ? '#20845a' : '#d54532',
          weight: 3,
          opacity: 0.9,
          dashArray: '4 5',
        })
          .bindTooltip(
            shift != null && shift <= 2
              ? 'OSM im Luftbild bestätigt'
              : `Abweichung${shift != null ? ` ${shift.toFixed(1)} m` : ''}`,
          )
          .addTo(target);
    });
    return () => {
      disposed = true;
      layer.clearLayers();
    };
  }, [currentAerial, currentReview, endpointReviews]);
  const navigateReview = (direction: -1 | 1) => {
    if (!reviewEndpoints.length) return;
    const next =
      reviewEndpoints[
        (reviewIndex + direction + reviewEndpoints.length) %
          reviewEndpoints.length
      ];
    focusEndpoint(next.edge, next.endpoint);
  };
  const startPlatformReview = () => {
    if (reviewEndpoints.length) {
      const next =
        reviewEndpoints.find((item) => !endpointReviews[item.key]) ??
        reviewEndpoints[0];
      focusEndpoint(next.edge, next.endpoint);
    }
    if (Object.keys(aerialResults).length || aerialChecksRunning) return;
    const tracks = platformEdges.length
      ? platformEdges.map((edge) => edge.track)
      : authoritativePlatforms.map((platform) => platform.track);
    if (!tracks.length) return;
    setAerialChecksRunning(true);
    void Promise.all(
      tracks.map(async (track) => {
        try {
          const existingEdge = platformEdges.find(
            (edge) => edge.track === track,
          );
          const isFriedbergPilot =
            identity?.stationNumber === '1930' ||
            /^Friedberg \(Hess\)/i.test(authoritativeName);
          const parameters = isFriedbergPilot
            ? new URLSearchParams({ track })
            : new URLSearchParams({
                name: authoritativeName,
                track,
                latitude: String(station.latitude),
                longitude: String(station.longitude),
              });
          const currentStart = existingEdge?.geometry[0];
          const currentEnd = existingEdge?.geometry.at(-1);
          if (currentStart && currentEnd) {
            parameters.set('start_latitude', String(currentStart.lat));
            parameters.set('start_longitude', String(currentStart.lon));
            parameters.set('end_latitude', String(currentEnd.lat));
            parameters.set('end_longitude', String(currentEnd.lon));
          }
          const endpoint = isFriedbergPilot
            ? `${API}/stations/friedberg-hess/aerial-analysis/osm`
            : `${API}/stations/aerial-analysis/osm`;
          const response = await fetch(`${endpoint}?${parameters}`, {
            cache: 'no-store',
          });
          if (!response.ok) throw new Error();
          const result = (await response.json()) as GenericAerialAnalysis;
          if (
            existingEdge &&
            result.candidate_start &&
            result.candidate_end &&
            (!belongsToPlatformSide(
              {
                lat: result.candidate_start.latitude,
                lon: result.candidate_start.longitude,
              },
              existingEdge,
              platformEdges,
            ) ||
              !belongsToPlatformSide(
                {
                  lat: result.candidate_end.latitude,
                  lon: result.candidate_end.longitude,
                },
                existingEdge,
                platformEdges,
              ))
          ) {
            result.status = 'check';
            result.reason =
              'Erkannter Abschluss liegt nicht eindeutig auf derselben Bahnsteigkante';
            delete result.candidate_start;
            delete result.candidate_end;
          }
          const fallbackEdge =
            !existingEdge && result.candidate_start && result.candidate_end
              ? {
                  id: `aerial-analysis-${track}`,
                  track,
                  trackSource: 'unknown' as const,
                  osmType: 'way' as const,
                  osmId: 0,
                  geometry: [
                    {
                      lat: result.candidate_start.latitude,
                      lon: result.candidate_start.longitude,
                    },
                    {
                      lat: result.candidate_end.latitude,
                      lon: result.candidate_end.longitude,
                    },
                  ],
                  length:
                    result.candidate_length_m ??
                    distance(
                      {
                        lat: result.candidate_start.latitude,
                        lon: result.candidate_start.longitude,
                      },
                      {
                        lat: result.candidate_end.latitude,
                        lon: result.candidate_end.longitude,
                      },
                    ),
                }
              : null;
          const edgeId = existingEdge?.id ?? fallbackEdge?.id;
          if (fallbackEdge)
            setPlatformEdges((current) =>
              current.some((edge) => edge.track === track)
                ? current
                : [...current, fallbackEdge].sort((a, b) =>
                    a.track.localeCompare(b.track, 'de', { numeric: true }),
                  ),
            );
          if (edgeId)
            setAerialResults((current) => ({ ...current, [edgeId]: result }));
          return fallbackEdge;
        } catch {
          const existingEdge = platformEdges.find(
            (edge) => edge.track === track,
          );
          if (existingEdge)
            setAerialResults((current) => ({
              ...current,
              [existingEdge.id]: {
                status: 'insufficient_evidence',
                confidence: 0,
                reason:
                  'Keine eindeutige automatische Luftbildauswertung verfügbar',
              },
            }));
          return null;
        }
      }),
    )
      .then((fallbackEdges) => {
        if (!reviewEndpoints.length) {
          const first = fallbackEdges.find(Boolean) as PlatformEdge | undefined;
          if (first) focusEndpoint(first, 'start');
        }
      })
      .finally(() => setAerialChecksRunning(false));
  };
  const reviewedEndpointCount = reviewEndpoints.filter((item) =>
    Boolean(endpointReviews[item.key]),
  ).length;
  const rateEndpoint = (status: 'correct' | 'none') => {
    if (!currentReview) return;
    setEndpointReviews((current) => ({
      ...current,
      [currentReview.key]: status,
    }));
    const point =
      currentReview.endpoint === 'start'
        ? currentReview.edge.geometry[0]
        : currentReview.edge.geometry.at(-1)!;
    const features =
      currentReview.endpoint === 'start'
        ? currentAerial?.start_features
        : currentAerial?.end_features;
    setLearningMessage('Bewertung wird als Lernbeispiel gespeichert …');
    void fetch(`${API}/stations/aerial-analysis/training-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track: `${authoritativeName}:${currentReview.edge.track}`,
        endpoint: currentReview.endpoint,
        accepted: status === 'correct',
        features: features ?? {},
        confirmed_coordinate:
          status === 'correct'
            ? { latitude: point.lat, longitude: point.lon }
            : null,
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error();
        setLearningMessage(
          'Bewertung gespeichert – die Erkennung lernt aus diesem Beispiel.',
        );
      })
      .catch(() =>
        setLearningMessage(
          'Bewertung lokal gespeichert; Lernserver derzeit nicht erreichbar.',
        ),
      );
    if (status === 'none') {
      setCorrectionError(null);
      setCorrectionTarget({
        edgeId: currentReview.edge.id,
        endpoint: currentReview.endpoint,
        track: currentReview.edge.track,
      });
    }
  };
  const applyAerialSuggestion = () => {
    if (
      !currentReview ||
      !currentAerial?.candidate_start ||
      !currentAerial.candidate_end
    )
      return;
    const start = {
      lat: currentAerial.candidate_start.latitude,
      lon: currentAerial.candidate_start.longitude,
    };
    const end = {
      lat: currentAerial.candidate_end.latitude,
      lon: currentAerial.candidate_end.longitude,
    };
    setCorrectedGeometries((drafts) => ({
      ...drafts,
      [currentReview.edge.id]: [start, end],
    }));
    setPlatformEdges((current) =>
      current.map((edge) =>
        edge.id === currentReview.edge.id
          ? {
              ...edge,
              geometry: [start, end],
              length: geometryLength([start, end]),
            }
          : edge,
      ),
    );
    setEndpointReviews((current) => ({
      ...current,
      [`${currentReview.edge.id}:start`]: 'corrected',
      [`${currentReview.edge.id}:end`]: 'corrected',
    }));
    const trainingTrack = `${authoritativeName}:${currentReview.edge.track}`;
    setLearningMessage(
      'Beide Korrekturen werden als Lernbeispiele gespeichert …',
    );
    void Promise.all(
      (['start', 'end'] as const).map((endpoint) => {
        const coordinate =
          endpoint === 'start'
            ? currentAerial.candidate_start!
            : currentAerial.candidate_end!;
        const features =
          endpoint === 'start'
            ? currentAerial.start_features
            : currentAerial.end_features;
        return fetch(`${API}/stations/aerial-analysis/training-feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            track: trainingTrack,
            endpoint,
            accepted: false,
            features: features ?? {},
            corrected_coordinate: coordinate,
          }),
        });
      }),
    )
      .then((responses) => {
        if (responses.some((response) => !response.ok)) throw new Error();
        setLearningMessage('Beide Korrekturen wurden gespeichert.');
      })
      .catch(() =>
        setLearningMessage(
          'Korrekturen lokal gespeichert; Lernserver derzeit nicht erreichbar.',
        ),
      );
  };
  const sourceState = (status?: string) =>
    status === undefined
      ? 'loading'
      : status === 'cached'
        ? 'cached'
        : ['active', 'available_for_enrichment'].includes(status)
          ? 'active'
          : status === 'not_found'
            ? 'not_found'
            : 'unavailable';
  const sourceEntries = [
    {
      key: 'stada',
      databaseKey: 'db-infrago-stada',
      name: 'DB InfraGO StaDa',
      quality: 'A',
      state: sourceState(dbSources.stada),
    },
    {
      key: 'netex',
      databaseKey: 'db-infrago-openstation-netex',
      name: 'DB InfraGO OpenStation / NeTEx',
      quality: 'A',
      state: sourceState(dbSources.netex),
    },
    {
      key: 'rinf',
      databaseKey: 'era-rinf',
      name: 'ERA Infrastrukturregister RINF (rinf-plus)',
      quality: 'A',
      state: sourceState(dbSources.rinf),
    },
    {
      key: 'osm',
      databaseKey: 'openstreetmap',
      name: 'OpenStreetMap',
      quality: 'D',
      state: dbSources.osm === 'cached' ? 'cached' : osmBaseMapStatus,
    },
    {
      key: 'satellite',
      databaseKey: '',
      name: 'Satellitenbild Esri / Maxar',
      quality: 'B',
      state: satelliteStatus,
    },
    {
      key: 'official',
      databaseKey: 'geoportal-hessen-dop20',
      name: 'Amtliches Luftbild',
      quality: 'A',
      state: officialImageryStatus,
    },
    {
      key: 'fasta',
      databaseKey: 'db-infrago-fasta',
      name: 'DB InfraGO FaSta',
      quality: 'A',
      state: sourceState(dbSources.fasta),
    },
  ];
  const sourceStatusLabel = (state: string) =>
    state === 'active'
      ? 'Aktiv'
      : state === 'cached'
        ? 'Cache / Referenzstand'
        : state === 'loading'
          ? 'Wird geladen'
          : state === 'not_found'
            ? 'Keine Stationsdaten'
            : 'Nicht erreichbar';
  const sourceFreshness = (key: string, state: string) =>
    sourceUpdated[key]
      ? `Letzter erfolgreicher Abruf: ${sourceUpdated[key].toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`
      : state === 'cached'
        ? 'Letzter erfolgreich gespeicherter Stationsstand'
        : state === 'loading'
          ? 'Aktualität wird ermittelt'
          : state === 'not_found'
            ? 'Quelle erreichbar, kein passender Datensatz'
            : 'Kein erfolgreicher Abruf in dieser Sitzung';
  const formatSourceDate = (value?: string) =>
    value
      ? new Date(value).toLocaleString('de-DE', {
          dateStyle: 'short',
          timeStyle: value.includes('T') ? 'short' : undefined,
        })
      : null;
  const sourceDataDate = (source: { key: string; databaseKey: string }) => {
    if (source.key === 'satellite')
      return 'Bildaufnahmedatum: standortabhängig; vom Kartendienst nicht ausgewiesen';
    if (source.key === 'official')
      return 'Orthofoto-Aufnahmedatum: im WMS-Layer nicht ausgewiesen';
    const stored = databaseFreshness.sources[source.databaseKey];
    const date = formatSourceDate(stored?.sourceDate ?? stored?.databaseUpdate);
    return date
      ? `Datenstand: ${date}`
      : 'Datenstand: von der Quelle nicht ausgewiesen';
  };
  const inventoryObjects = inventory?.objects ?? [];
  const inventoryCounts = Object.fromEntries(
    ['platform', 'platform_edge', 'entrance', 'equipment'].map((type) => [
      type,
      inventoryObjects.filter((item) => item.object_type === type).length,
    ]),
  );
  const normalizedInventoryQuery = normalizeSearch(inventoryQuery.trim());
  const filteredInventory = inventoryObjects.filter((item) => {
    if (inventoryType !== 'all' && item.object_type !== inventoryType)
      return false;
    if (!normalizedInventoryQuery) return true;
    return normalizeSearch(
      [
        item.object_key,
        objectTypeLabels[item.object_type],
        ...item.observations.map((observation) => String(observation.value)),
      ].join(' '),
    ).includes(normalizedInventoryQuery);
  });
  const selectedInventoryObject =
    inventoryObjects.find((item) => item.object_key === selectedObjectKey) ??
    filteredInventory[0] ??
    null;
  const objectTitle = (item: InventoryObject) =>
    String(
      item.observations.find((observation) => observation.attribute === 'name')
        ?.value ??
        objectTypeLabels[item.object_type] ??
        item.object_type,
    );
  const displayInventoryValue = (value: unknown, unit?: string | null) =>
    `${typeof value === 'boolean' ? (value ? 'Ja' : 'Nein') : String(value ?? 'Nicht geliefert')}${unit && unit !== 'degree' ? ` ${unit}` : ''}`;
  const sourceLabel = (key: string) =>
    ({
      'db-infrago-stada': 'DB InfraGO StaDa',
      'db-open-station': 'DB OpenStation / NeTEx',
      'era-rinf': 'ERA RINF',
      openstreetmap: 'OpenStreetMap',
      osm: 'OpenStreetMap',
      fasta: 'DB InfraGO FaSta',
    })[key.toLowerCase()] ?? key;
  const latestObservations = (item: InventoryObject) =>
    Array.from(
      new Map(
        item.observations.map((observation) => [
          `${observation.attribute}:${observation.source_key}`,
          observation,
        ]),
      ).values(),
    );
  const focusInventoryObject = (item: InventoryObject) => {
    setSelectedObjectKey(item.object_key);
    const observation = (attribute: string) =>
      item.observations.find((entry) => entry.attribute === attribute)?.value;
    const latitude = Number(observation('latitude'));
    const longitude = Number(observation('longitude'));
    const track = String(observation('public_code') ?? '').trim();
    const edge = track
      ? platformEdges.find((candidate) => candidate.track === track)
      : undefined;
    if (edge) focusPlatformLength(edge);
    else if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      setImagery(officialImageryStatus === 'active' ? 'official' : 'satellite');
      mapRef.current?.setView([latitude, longitude], 21, { animate: false });
      requestAnimationFrame(() =>
        el.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      );
    }
  };
  const equipmentTypes = Array.from(
    new Set(
      inventoryObjects
        .filter((item) => item.object_type === 'equipment')
        .map((item) =>
          String(
            item.observations.find(
              (entry) => entry.attribute === 'equipment_type',
            )?.value ?? objectTitle(item),
          ),
        ),
    ),
  ).filter(Boolean);
  const dataGaps = [
    ...(!identity?.eva || !identity?.ril
      ? ['Stationskennung unvollständig']
      : []),
    ...(platformRows.some(({ edge }) => !edge)
      ? ['Bahnsteigkante nicht in OSM zugeordnet']
      : []),
    ...(platformRows.some(({ data }) => data?.net_construction_length_m == null)
      ? ['DB-Nettobaulänge fehlt']
      : []),
    ...(platformRows.some(({ data }) => data?.usable_length_m == null)
      ? ['RINF-Nutzlänge fehlt']
      : []),
    ...(inventoryCounts.entrance > 0 && counts.entrances === 0
      ? ['Zugang nicht verortet']
      : []),
  ];
  const conflictCount =
    lengthComparisons.filter((item) => item.level === 'high').length +
    Object.values(aerialResults).filter((item) => item.status === 'high')
      .length;
  const mappingMethodLabel = (method?: string | null) =>
    ({
      exact_platform_id: 'Gleiche Bahnsteigkennung',
      station_crosswalk: 'Bestätigter Stations-Crosswalk',
      bijective_remainder: 'Eindeutige Restzuordnung',
      cached_reference: 'Letzter bestätigter Stations-Crosswalk',
      unmapped: 'Keine belastbare Zuordnung',
    })[method ?? ''] ?? 'Noch nicht zugeordnet';
  const mappingResultLabel = (data?: AuthoritativePlatform) =>
    data?.rinf_platform_id
      ? `RINF ${data.rinf_platform_id} → DB Gleis ${data.track}`
      : `DB Gleis ${data?.track ?? '–'} ohne RINF-Zuordnung`;
  const stationMasterRows = [
    {
      subject: 'Station',
      attribute: 'Stationsname',
      value: authoritativeName,
      source: 'DB InfraGO StaDa',
    },
    {
      subject: 'Station',
      attribute: 'DB-Stationsnummer',
      value: identity?.stationNumber ?? 'Nicht geliefert',
      source: 'DB InfraGO StaDa',
    },
    {
      subject: 'Station',
      attribute: 'EVA / IBNR',
      value: identity?.eva ?? 'Nicht geliefert',
      source: 'DB InfraGO StaDa',
    },
    {
      subject: 'Strecke / Betriebsstelle',
      attribute: 'RIL 100',
      value: identity?.ril ?? 'Nicht geliefert',
      source: 'DB InfraGO StaDa',
    },
    {
      subject: 'Strecke / Betriebsstelle',
      attribute: 'Streckenzuordnung',
      value: 'In den angebundenen Stationsdaten nicht geliefert',
      source: 'DB InfraGO / NeTEx',
    },
    ...platformRows.map(({ track, data }) => ({
      subject: 'Gleis',
      attribute: `Gleis ${track}`,
      value: data?.rinf_platform_id
        ? `RINF-Bahnsteigkennung ${data.rinf_platform_id}`
        : 'RINF-Bahnsteigkennung nicht zugeordnet',
      source: data?.rinf_platform_id ? 'DB InfraGO + ERA RINF' : 'DB InfraGO',
    })),
  ];
  return (
    <section className="selected-station-card">
      <div className="selected-station-heading">
        <div>
          <p className="map-kicker">KARTENEINSTIEG</p>
          <h2>{displayName} im Lageplan</h2>
          <p>
            Stationsstammdaten aus DB InfraGO StaDa; NeTEx und europäische
            Register ergänzen. OpenStreetMap liefert nachrangig die Geometrie.
          </p>
        </div>
        <div className="station-heading-actions">
          <button
            type="button"
            className="refresh-station"
            onClick={() => setRefreshNonce((value) => value + 1)}
          >
            <RefreshCw size={15} />
            Aktualisieren
          </button>
          {lastUpdated ? (
            <small>
              Abruf{' '}
              {lastUpdated.toLocaleTimeString('de-DE', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </small>
          ) : null}
          <button type="button" onClick={onBack}>
            Zur Deutschlandkarte
          </button>
        </div>
      </div>
      {loadError ? (
        <div className="station-load-error" role="alert">
          <AlertTriangle size={18} />
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setRefreshNonce((value) => value + 1)}
          >
            Erneut laden
          </button>
        </div>
      ) : null}
      <div className="selected-station-map-wrap">
        <div
          ref={el}
          className="selected-station-map"
          aria-label={`Lageplan ${displayName}`}
        />
        <div
          className="generic-map-controls map-controls"
          aria-label="Kartenebenen"
        >
          <button
            type="button"
            className={
              imagery === 'satellite'
                ? 'map-toggle map-toggle-active'
                : 'map-toggle'
            }
            onClick={() =>
              setImagery(imagery === 'satellite' ? 'none' : 'satellite')
            }
          >
            <Satellite size={16} />
            <span>Satellit</span>
          </button>
          {officialImageryAvailable ? (
            <button
              type="button"
              className={
                imagery === 'official'
                  ? 'map-toggle map-toggle-active'
                  : 'map-toggle'
              }
              onClick={() =>
                setImagery(
                  imagery === 'official'
                    ? 'none'
                    : officialImageryStatus === 'active'
                      ? 'official'
                      : 'satellite',
                )
              }
            >
              <Layers3 size={16} />
              <span>Amtliches Luftbild</span>
            </button>
          ) : null}
          {imagery !== 'none' ? (
            <label className="opacity-control">
              <span>Deckkraft</span>
              <input
                type="range"
                min="20"
                max="100"
                step="5"
                value={imageryOpacity}
                onChange={(event) =>
                  setImageryOpacity(Number(event.target.value))
                }
                aria-label="Deckkraft des Luftbilds"
              />
              <strong>{imageryOpacity}%</strong>
            </label>
          ) : null}
          <button
            type="button"
            className="map-icon-button"
            onClick={() =>
              mapRef.current?.setView(
                [station.latitude, station.longitude],
                17,
                { animate: false },
              )
            }
            aria-label="Bahnhof zentrieren"
          >
            <MapPin size={17} />
          </button>
        </div>
      </div>
      {correctionError ? (
        <div className="endpoint-corridor-error" role="alert">
          {correctionError} Anfang und Ende müssen zur selben Bahnsteigkante
          gehören.
        </div>
      ) : null}
      {currentReview ? (
        <div className="endpoint-review-nav generic-endpoint-review">
          <button
            type="button"
            onClick={() => navigateReview(-1)}
            aria-label="Vorherigen Endpunkt prüfen"
          >
            ‹
          </button>
          <div>
            <strong>
              Gleis {currentReview.edge.track} ·{' '}
              {currentReview.endpoint === 'start' ? 'Anfang' : 'Ende'}
            </strong>
            <span>
              {correctionTarget
                ? 'Richtigen Abschluss in der Karte anklicken'
                : endpointReviews[currentReview.key] === 'correct'
                  ? 'Abschluss bestätigt'
                  : endpointReviews[currentReview.key] === 'corrected'
                    ? 'Richtiger Abschluss gesetzt'
                    : endpointReviews[currentReview.key] === 'none'
                      ? 'Kein Abschluss – Korrektur erwartet'
                      : currentAerial?.status === 'plausible'
                        ? `Luftbild plausibel · ${Math.round(currentAerial.confidence * 100)}%`
                        : currentAerial?.maximum_endpoint_shift_m != null
                          ? `Abweichung ${currentAerial.maximum_endpoint_shift_m.toFixed(1)} m · ${Math.round(currentAerial.confidence * 100)}%`
                          : aerialChecksRunning
                            ? 'Amtliches Luftbild wird ausgewertet …'
                            : (currentAerial?.reason ?? 'Noch nicht geprüft')}
            </span>
            {currentAerial?.candidate_length_m != null ? (
              <small>
                Erkannte Länge: {currentAerial.candidate_length_m.toFixed(1)} m
              </small>
            ) : null}
            <span className="learning-mode-status">
              <i aria-hidden="true" />
              Lernmodus aktiv · {currentAerial?.training_sample_count ?? 0}{' '}
              Bewertungen
            </span>
            <div className="endpoint-learning-actions">
              <button
                type="button"
                className={
                  endpointReviews[currentReview.key] === 'correct'
                    ? 'learning-correct-active'
                    : ''
                }
                onClick={() => rateEndpoint('correct')}
              >
                Abschluss korrekt
              </button>
              <button
                type="button"
                className={
                  endpointReviews[currentReview.key] === 'none'
                    ? 'learning-wrong-active'
                    : ''
                }
                onClick={() => rateEndpoint('none')}
              >
                Kein Abschluss
              </button>
              <button
                type="button"
                className={
                  endpointReviews[currentReview.key] === 'corrected'
                    ? 'learning-corrected-active'
                    : ''
                }
                onClick={() =>
                  setCorrectionTarget({
                    edgeId: currentReview.edge.id,
                    endpoint: currentReview.endpoint,
                    track: currentReview.edge.track,
                  })
                }
              >
                {endpointReviews[currentReview.key] === 'corrected'
                  ? 'Richtiger Abschluss gesetzt'
                  : 'Richtigen Abschluss setzen'}
              </button>
            </div>
            {learningMessage ? (
              <output className="review-learning-message">
                {learningMessage}
              </output>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => navigateReview(1)}
            aria-label="Nächsten Endpunkt prüfen"
          >
            ›
          </button>
        </div>
      ) : null}
      {currentReview &&
      currentAerial?.candidate_start &&
      currentAerial.candidate_end &&
      currentAerial.status !== 'plausible' ? (
        <button
          type="button"
          className="generic-aerial-apply"
          onClick={applyAerialSuggestion}
        >
          Luftbildvorschlag als beide Prüfpunkte übernehmen
        </button>
      ) : null}
      <div className="generic-station-metrics">
        <div>
          <strong>{inventory?.object_count ?? '–'}</strong>
          <span>Infrastrukturobjekte</span>
        </div>
        <div>
          <strong>{platformRows.length}</strong>
          <span>Bahnsteigkanten</span>
        </div>
        <div>
          <strong>{counts.entrances}</strong>
          <span>Zugänge</span>
        </div>
        <div>
          <strong>{counts.equipment}</strong>
          <span>Ausstattung</span>
        </div>
        <div>
          <strong>{conflictCount}</strong>
          <span>Aktuelle Konflikte</span>
        </div>
      </div>
      <section className="generic-feature-card">
        <div className="generic-feature-heading">
          <div>
            <h2>Datenquellen</h2>
            <p>
              Aktive Verbindungen und Qualitätsklasse für {authoritativeName}
            </p>
            <p className="database-update-date">
              Letzte Aktualisierung der Infrastrukturdatenbank:{' '}
              {formatSourceDate(databaseFreshness.lastUpdate) ??
                'noch nicht ausgewiesen'}
            </p>
          </div>
          <strong>
            {sourceEntries.filter((source) => source.state === 'active').length}{' '}
            von {sourceEntries.length} verbunden
          </strong>
        </div>
        <div className="source-grid">
          {sourceEntries.map((source) => (
            <div className="source-row" key={source.name}>
              <span
                className={`source-indicator ${source.state === 'active' ? 'source-active' : source.state === 'cached' ? 'source-cached' : source.state === 'unavailable' ? 'source-error' : 'source-pending'}`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{source.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Qualitätsklasse {source.quality}
                </p>
                <p className="source-freshness">
                  {sourceDataDate(source)}
                  <br />
                  {sourceFreshness(source.key, source.state)}
                </p>
              </div>
              <span
                className={
                  source.state === 'active'
                    ? 'source-state-active'
                    : source.state === 'cached'
                      ? 'source-state-cached'
                      : source.state === 'unavailable'
                        ? 'source-state-error'
                        : 'source-state-pending'
                }
              >
                {sourceStatusLabel(source.state)}
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className="platform-check-panel generic-platform-check">
        <div>
          <strong>Bahnsteigdaten und Plausibilitätscheck</strong>
          <span>
            OSM-Baulänge wird wie in Friedberg gegen die DB-Nettobaulänge
            geprüft; Anfang und Ende bleiben unabhängig prüfbar.
          </span>
        </div>
        <div className="generic-check-actions">
          <div className="comparison-summary">
            <span className="comparison-low">
              {lengthComparisons.filter((item) => item.level === 'low').length}{' '}
              geringe
            </span>
            <span className="comparison-check">
              {
                lengthComparisons.filter((item) => item.level === 'check')
                  .length
              }{' '}
              prüfen
            </span>
            <span className="comparison-high">
              {lengthComparisons.filter((item) => item.level === 'high').length}{' '}
              auffällig
            </span>
          </div>
          <button
            type="button"
            className={
              reviewKey
                ? 'platform-check-switch platform-check-switch-on'
                : 'platform-check-switch'
            }
            onClick={startPlatformReview}
            disabled={!platformRows.length}
          >
            {aerialChecksRunning ? (
              <i className="running-spinner" aria-hidden="true" />
            ) : (
              <span aria-hidden="true" />
            )}
            <span className="platform-check-switch-label">
              Bahnsteigkanten prüfen
              <small>
                {aerialChecksRunning
                  ? `Luftbildprüfung läuft (${Object.keys(aerialResults).length}/${Math.max(platformEdges.length, authoritativePlatforms.length)})`
                  : `${reviewedEndpointCount}/${reviewEndpoints.length} Endpunkte bearbeitet`}
              </small>
            </span>
          </button>
        </div>
      </div>
      {reviewKey || Object.keys(aerialResults).length ? (
        <>
          <p className="aerial-confidence-explanation">
            <strong>Erkennungssicherheit:</strong> Der Prozentwert beschreibt,
            wie sicher die Luftbildanalyse den jeweiligen Abschluss erkennt. 100
            % bedeutet höchste Modellsicherheit; der Wert ist keine
            Längenabweichung und ersetzt nicht die fachliche Bestätigung.
          </p>
          <div
            className="platform-check-results"
            aria-label="Ergebnisse der Bahnsteigkantenprüfung"
          >
            {platformEdges.map((edge) => {
              const result = aerialResults[edge.id];
              const endpointResult = (endpoint: 'start' | 'end') => {
                const review = endpointReviews[`${edge.id}:${endpoint}`];
                const shift =
                  endpoint === 'start'
                    ? result?.start_shift_m
                    : result?.end_shift_m;
                const probability =
                  endpoint === 'start'
                    ? result?.start_learned_probability
                    : result?.end_learned_probability;
                const confidence = result
                  ? Math.round((probability ?? result.confidence) * 100)
                  : null;
                const text =
                  review === 'correct'
                    ? 'OSM bestätigt'
                    : review === 'corrected'
                      ? 'Richtiger Abschluss gesetzt'
                      : review === 'none'
                        ? 'Kein Abschluss – Korrektur offen'
                        : shift != null
                          ? `${shift >= 0 ? '+' : ''}${shift.toFixed(1)} m`
                          : aerialChecksRunning
                            ? 'Wird geprüft …'
                            : (result?.reason ?? 'Noch nicht geprüft');
                return (
                  <button
                    type="button"
                    className="endpoint-result-jump"
                    onClick={() => focusEndpoint(edge, endpoint)}
                  >
                    <span>
                      <b>{endpoint === 'start' ? 'Anfang' : 'Ende'}</b>
                      <small>Im Luftbild prüfen</small>
                    </span>
                    <strong>{text}</strong>
                    {confidence != null ? (
                      <small className="result-confidence">
                        Erkennungssicherheit: {confidence} %
                        {probability != null
                          ? ' · Lernmodell'
                          : ' · Bildanalyse'}
                      </small>
                    ) : null}
                  </button>
                );
              };
              const level =
                result?.status === 'plausible'
                  ? 'plausible'
                  : result?.status === 'check'
                    ? 'check'
                    : result
                      ? 'high'
                      : 'check';
              return (
                <article
                  key={edge.id}
                  className={`platform-check-result platform-check-result-${level}`}
                >
                  <button
                    type="button"
                    className="platform-result-track"
                    onClick={() => focusEndpoint(edge, 'start')}
                  >
                    Gleis {edge.track}
                  </button>
                  {endpointResult('start')}
                  {endpointResult('end')}
                  {result ? (
                    <small className="result-learning-status">
                      Lernmodus aktiv · {result.training_sample_count ?? 0}{' '}
                      Bewertungen
                    </small>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="generic-platform-scroll">
        <table className="platform-data-table">
          <thead>
            <tr>
              <th>Gleis</th>
              <th>Bahnsteighöhe</th>
              <th>Baulänge OSM</th>
              <th>OSM-Daten bestätigt</th>
              <th>Nettobaulänge DB</th>
              <th>Abweichung OSM–DB</th>
              <th>Gleisbezogene Bahnsteignutzlänge</th>
              <th>Anfang Geokoordinaten</th>
              <th>Ende Geokoordinaten</th>
            </tr>
          </thead>
          <tbody>
            {platformRows.map(({ track, edge, data }) => {
              const start = edge?.geometry[0],
                end = edge?.geometry.at(-1);
              const originalGeometry = edge
                ? originalGeometriesRef.current[edge.id]
                : undefined;
              const originalStart = originalGeometry?.[0],
                originalEnd = originalGeometry?.at(-1);
              const corrected = edge
                ? Boolean(correctedGeometries[edge.id])
                : false;
              const comparison = lengthComparison(edge, data);
              const plausibility = geometryPlausibility(edge);
              const confirmed = edge ? Boolean(osmConfirmed[edge.id]) : false;
              const dbNeedsReview = confirmed && comparison?.level === 'high';
              const coordinateContent = (endpoint: 'start' | 'end') => {
                if (!edge)
                  return (
                    <span className="data-missing">Keine OSM-Koordinate</span>
                  );
                const point = endpoint === 'start' ? start : end;
                const original =
                  endpoint === 'start' ? originalStart : originalEnd;
                if (!point)
                  return (
                    <span className="data-missing">Keine OSM-Koordinate</span>
                  );
                return (
                  <button
                    type="button"
                    className={
                      corrected
                        ? 'generic-endpoint-button updated-coordinate'
                        : 'generic-endpoint-button'
                    }
                    onClick={() => focusEndpoint(edge, endpoint)}
                  >
                    {corrected ? (
                      <span className="updated-badge">Aktualisiert</span>
                    ) : null}
                    <strong>
                      {point.lat.toFixed(6)}, {point.lon.toFixed(6)}
                    </strong>
                    <span>
                      {corrected ? 'Aktive Koordinate' : 'Im Luftbild prüfen'}
                    </span>
                    {corrected && original ? (
                      <small>
                        OSM bisher: {original.lat.toFixed(6)},{' '}
                        {original.lon.toFixed(6)}
                      </small>
                    ) : null}
                  </button>
                );
              };
              return (
                <tr
                  key={`${track}-${edge?.id ?? 'db'}`}
                  className={
                    comparison?.level === 'high'
                      ? 'row-deviation-high'
                      : undefined
                  }
                >
                  <td>
                    <div className="data-value">
                      {edge ? (
                        <button
                          type="button"
                          className="track-pill track-pill-button"
                          onClick={() => focusPlatformLength(edge)}
                          title={`Gleis ${track} im Luftbild anzeigen`}
                        >
                          Gleis {track}
                        </button>
                      ) : (
                        <span className="track-pill">Gleis {track}</span>
                      )}
                      {edge?.trackSource === 'ref' ? (
                        <span>
                          OSM ref={track} ·{' '}
                          {edge.osmType === 'way' ? 'Weg' : 'Knoten'}{' '}
                          {edge.osmId}
                        </span>
                      ) : edge?.trackSource === 'local_ref' ? (
                        <span>OSM local_ref={track}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className="data-value">
                      <strong>
                        {data?.platform_height_mm != null
                          ? `${data.platform_height_mm} mm`
                          : edge?.height
                            ? `${Number(edge.height) * 1000} mm`
                            : 'Nicht geliefert'}
                      </strong>
                      <span>
                        {data?.platform_height_mm != null
                          ? 'DB InfraGO'
                          : 'OpenStreetMap'}
                      </span>
                    </div>
                  </td>
                  <td>
                    {edge ? (
                      <div className="data-value">
                        {corrected ? (
                          <div className="updated-length">
                            <span className="updated-badge">Aktualisiert</span>
                            <strong>{edge.length.toFixed(1)} m</strong>
                            <span>
                              Neue OSM-Länge · Grundlage der Abweichung
                            </span>
                          </div>
                        ) : (
                          <>
                            <strong>{edge.length.toFixed(1)} m</strong>
                            <span>OSM-Geometrie</span>
                          </>
                        )}
                        {corrected && originalGeometry ? (
                          <span>
                            OSM bisher:{' '}
                            {geometryLength(originalGeometry).toFixed(1)} m
                          </span>
                        ) : null}
                        <div
                          className={`osm-plausibility osm-plausibility-${plausibility.level}`}
                        >
                          <strong>
                            {plausibility.level === 'ok'
                              ? 'OSM plausibel'
                              : plausibility.level === 'check'
                                ? 'OSM prüfen'
                                : 'OSM auffällig'}
                          </strong>
                          <span>{plausibility.reason}</span>
                        </div>
                        <a
                          className="source-data-link"
                          href={`https://www.openstreetmap.org/${edge.osmType}/${edge.osmId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Original OSM{' '}
                          {edge.osmType === 'way' ? 'Weg' : 'Knoten'}{' '}
                          {edge.osmId}
                        </a>
                      </div>
                    ) : (
                      <span className="data-missing">
                        Keine OSM-Kante zugeordnet
                      </span>
                    )}
                  </td>
                  <td>
                    {edge ? (
                      <button
                        type="button"
                        className={
                          confirmed
                            ? 'osm-confirm osm-confirmed'
                            : 'osm-confirm'
                        }
                        aria-pressed={confirmed}
                        onClick={() =>
                          setOsmConfirmed((current) => ({
                            ...current,
                            [edge.id]: !current[edge.id],
                          }))
                        }
                      >
                        <ShieldCheck size={15} />
                        {confirmed ? 'Bestätigt' : 'Bestätigen'}
                      </button>
                    ) : (
                      <span className="data-missing">Nicht möglich</span>
                    )}
                  </td>
                  <td>
                    {data?.net_construction_length_m != null ? (
                      <div
                        className={
                          dbNeedsReview ? 'db-length-review' : 'data-value'
                        }
                      >
                        <strong>
                          {data.net_construction_length_m.toFixed(1)} m
                        </strong>
                        <span>DB InfraGO Stationsausstattung</span>
                        {dbNeedsReview ? (
                          <span>
                            DB-Nettobaulänge prüfen: bestätigte OSM-Länge weicht
                            wesentlich ab
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="data-missing">
                        Bei DB InfraGO nicht geliefert
                      </span>
                    )}
                  </td>
                  <td>
                    {comparison && edge ? (
                      <button
                        type="button"
                        className={`deviation deviation-${comparison.level} deviation-button`}
                        onClick={() => focusPlatformLength(edge)}
                        title="Bahnsteigkante im Luftbild anzeigen"
                      >
                        <strong>
                          OSM {Math.abs(comparison.delta).toFixed(1)} m{' '}
                          {comparison.delta >= 0 ? 'länger' : 'kürzer'}
                        </strong>
                        <span>
                          als DB · {comparison.percent.toFixed(1)}% ·{' '}
                          {comparison.level === 'low'
                            ? 'gering'
                            : comparison.level === 'check'
                              ? 'prüfen'
                              : 'auffällig'}
                        </span>
                        <span>Im Luftbild prüfen</span>
                      </button>
                    ) : (
                      <span className="data-missing">Nicht vergleichbar</span>
                    )}
                  </td>
                  <td>
                    {data?.usable_length_m != null ? (
                      <div className="data-value">
                        <strong>{data.usable_length_m.toFixed(1)} m</strong>
                        <span>
                          RINF {data.rinf_platform_id || track}
                          {data.rinf_platform_id &&
                          data.rinf_platform_id !== track
                            ? ` → DB Gleis ${track}`
                            : ''}
                        </span>
                        {data.rinf_track_id ? (
                          <span>
                            Track-ID {data.rinf_track_id} ·{' '}
                            {data.mapping_confidence === 'confirmed'
                              ? 'bestätigt'
                              : data.mapping_confidence === 'derived'
                                ? 'eindeutig abgeleitet'
                                : 'nicht zugeordnet'}
                          </span>
                        ) : null}
                        {data.net_construction_length_m != null &&
                        data.net_construction_length_m - data.usable_length_m >
                          0 &&
                        data.net_construction_length_m - data.usable_length_m <
                          5 ? (
                          <span className="automatic-check">
                            Nur{' '}
                            {(
                              data.net_construction_length_m -
                              data.usable_length_m
                            ).toFixed(1)}{' '}
                            m kürzer als Nettobaulänge
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="data-missing">
                        In RINF nicht zugeordnet
                      </span>
                    )}
                  </td>
                  <td>{coordinateContent('start')}</td>
                  <td>{coordinateContent('end')}</td>
                </tr>
              );
            })}
            {!loading && !platformRows.length ? (
              <tr>
                <td colSpan={9}>
                  <span className="data-missing">
                    Keine Bahnsteigdaten in DB InfraGO, RINF oder OSM gefunden.
                  </span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="platform-data-note">
        <ShieldCheck size={16} />
        <p>
          OSM-Geometrie, DB-Nettobaulänge und RINF-Nutzlänge bleiben getrennte
          Quellen. Bestätigungen und Endpunktkorrekturen werden je Station
          gespeichert; auffällige Werte werden nicht automatisch überschrieben.
        </p>
      </div>
      <section className="pilot-summary-grid" aria-label="Qualitätsübersicht">
        <div>
          <h3>Datenlücken</h3>
          {dataGaps.length ? (
            <ul>
              {dataGaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          ) : (
            <p className="summary-ok">
              Keine automatischen Datenlücken erkannt.
            </p>
          )}
        </div>
        <div>
          <h3>Ausstattungstypen</h3>
          {equipmentTypes.length ? (
            <ul>
              {equipmentTypes.map((type) => (
                <li key={type}>{type}</li>
              ))}
            </ul>
          ) : (
            <p>Keine Ausstattungstypen geliefert.</p>
          )}
        </div>
      </section>
      <section className="generic-feature-card">
        <div className="generic-feature-heading">
          <div>
            <h2>Bahnsteigübersicht</h2>
            <p>DB-Gleisnummern mit zugeordneten RINF-Infrastrukturkennungen</p>
          </div>
          <span className="status-ok">
            <ShieldCheck size={15} />
            Identität geprüft
          </span>
        </div>
        <div className="generic-platform-overview">
          {platformRows.map(({ track, edge, data }, index) => {
            const check = lengthComparison(edge, data);
            return (
              <div className="generic-platform-row" key={`overview-${track}`}>
                <strong>B{index + 1}</strong>
                <div>
                  <span>Bahnsteig Gleis {track}</span>
                  <div>
                    {edge ? (
                      <button
                        type="button"
                        className="track-pill track-pill-button"
                        onClick={() => focusPlatformLength(edge)}
                        title={`Gleis ${track} im Luftbild anzeigen`}
                      >
                        Gleis {track}
                      </button>
                    ) : (
                      <span className="track-pill">Gleis {track}</span>
                    )}
                    {data?.rinf_platform_id ? (
                      <small>
                        RINF {data.rinf_platform_id}
                        {data.rinf_platform_id !== track
                          ? ` → Gleis ${track}`
                          : ''}
                      </small>
                    ) : (
                      <small>RINF nicht zugeordnet</small>
                    )}
                    {check ? (
                      <small>
                        {Math.abs(check.delta).toFixed(1)} m Abweichung ·{' '}
                        {check.level === 'low'
                          ? 'gering'
                          : check.level === 'check'
                            ? 'prüfen'
                            : 'auffällig'}
                      </small>
                    ) : null}
                  </div>
                </div>
                <i
                  className={
                    check
                      ? `platform-overview-${check.level}`
                      : 'platform-overview-missing'
                  }
                  aria-hidden="true"
                />
              </div>
            );
          })}
        </div>
      </section>
      <section className="generic-feature-card station-master-card">
        <div className="generic-feature-heading">
          <div>
            <h2>Stammdaten und Matching</h2>
            <p>
              Station, Betriebsstelle und Gleise mit Herkunft und
              nachvollziehbarer Zuordnung
            </p>
          </div>
        </div>
        <div className="station-master-scroll">
          <table className="station-master-table">
            <thead>
              <tr>
                <th>Bereich</th>
                <th>Merkmal</th>
                <th>Wert</th>
                <th>Quelle</th>
              </tr>
            </thead>
            <tbody>
              {stationMasterRows.map((row, index) => (
                <tr key={`${row.subject}-${row.attribute}-${index}`}>
                  <td>
                    <strong>{row.subject}</strong>
                  </td>
                  <td>{row.attribute}</td>
                  <td>{row.value}</td>
                  <td>
                    <span className="evidence-source">{row.source}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="matching-workflow-heading">
          <h3>Matching-Workflow und Ergebnis</h3>
          <p>
            Die Zuordnung bleibt quellengetrennt und wird nur bei ausreichender
            Evidenz übernommen.
          </p>
        </div>
        <div className="station-master-scroll">
          <table className="station-master-table matching-workflow-table">
            <thead>
              <tr>
                <th>DB-Gleis</th>
                <th>Eingangsdaten</th>
                <th>Prüfschritte</th>
                <th>Ergebnis</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {platformRows.map(({ track, edge, data }) => (
                <tr key={`workflow-${track}`}>
                  <td>
                    <span className="track-pill">Gleis {track}</span>
                  </td>
                  <td>
                    <span>DB InfraGO Gleis {track}</span>
                    <br />
                    <span>
                      {edge
                        ? `OSM ${edge.trackSource === 'ref' ? 'ref' : edge.trackSource === 'local_ref' ? 'local_ref' : 'Geometrie'}=${edge.track}`
                        : 'Keine OSM-Kante'}
                    </span>
                    <br />
                    <span>
                      {data?.rinf_platform_id
                        ? `RINF ${data.rinf_platform_id}`
                        : 'Kein RINF-Kandidat'}
                    </span>
                  </td>
                  <td>
                    <ol>
                      <li>Stationskennung abgleichen</li>
                      <li>Gleis-/Bahnsteigkennung prüfen</li>
                      <li>Räumliche Lage und Längen plausibilisieren</li>
                    </ol>
                    <strong>{mappingMethodLabel(data?.mapping_method)}</strong>
                  </td>
                  <td>
                    <strong>{mappingResultLabel(data)}</strong>
                    {data?.mapping_evidence?.length ? (
                      <small>{data.mapping_evidence.join(' · ')}</small>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`matching-status matching-status-${data?.mapping_confidence === 'confirmed' ? 'confirmed' : data?.mapping_confidence === 'derived' ? 'derived' : 'open'}`}
                    >
                      {data?.mapping_confidence === 'confirmed'
                        ? 'Bestätigt'
                        : data?.mapping_confidence === 'derived'
                          ? 'Eindeutig abgeleitet'
                          : 'Offen'}
                      {data?.mapping_score != null
                        ? ` · ${data.mapping_score} Punkte`
                        : ''}
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && !platformRows.length ? (
                <tr>
                  <td colSpan={5}>
                    <span className="data-missing">
                      Keine Gleise für den Matching-Workflow gefunden.
                    </span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <section className="object-catalog generic-object-catalog">
        <div className="catalog-toolbar">
          <div>
            <h2>Objektkatalog</h2>
            <p>Infrastruktur durchsuchen und Evidenz im Detail prüfen</p>
          </div>
          <div className="catalog-search">
            <Search size={17} />
            <input
              value={inventoryQuery}
              onChange={(event) => setInventoryQuery(event.target.value)}
              placeholder="Name, Gleis oder NeTEx-ID"
              aria-label="Objektkatalog durchsuchen"
            />
          </div>
        </div>
        <div className="catalog-filters" aria-label="Objekttyp filtern">
          {[
            ['all', 'Alle'],
            ['platform', 'Bahnsteig'],
            ['platform_edge', 'Bahnsteigkante'],
            ['entrance', 'Zugang'],
            ['equipment', 'Ausstattung'],
          ].map(([type, label]) => (
            <button
              type="button"
              key={type}
              className={inventoryType === type ? 'active' : ''}
              onClick={() => setInventoryType(type)}
            >
              {label}
              {type !== 'all' ? (
                <span>{inventoryCounts[type] ?? 0}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="catalog-body">
          <div
            className="object-list"
            role="list"
            aria-label={`${filteredInventory.length} gefundene Objekte`}
          >
            <p className="catalog-result-count">
              {filteredInventory.length} Objekte
            </p>
            {filteredInventory.map((item) => (
              <button
                role="listitem"
                type="button"
                key={item.object_key}
                onClick={() => focusInventoryObject(item)}
                className={
                  selectedInventoryObject?.object_key === item.object_key
                    ? 'object-row object-row-active'
                    : 'object-row'
                }
                aria-current={
                  selectedInventoryObject?.object_key === item.object_key
                    ? 'true'
                    : undefined
                }
              >
                <span className={`type-dot type-${item.object_type}`} />
                <span>
                  <strong>{objectTitle(item)}</strong>
                  <small>
                    {objectTypeLabels[item.object_type] ?? item.object_type} ·{' '}
                    {latestObservations(item).length} Werte
                  </small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
            {inventory === null ? (
              <div className="catalog-empty">
                NeTEx-Infrastruktur wird geladen …
              </div>
            ) : !filteredInventory.length ? (
              <div className="catalog-empty">
                Keine passenden Objekte gefunden
              </div>
            ) : null}
          </div>
          <div className="object-detail">
            {selectedInventoryObject ? (
              <>
                <span className="object-type-badge">
                  {objectTypeLabels[selectedInventoryObject.object_type] ??
                    selectedInventoryObject.object_type}
                </span>
                <h3>{objectTitle(selectedInventoryObject)}</h3>
                <code>{selectedInventoryObject.object_key}</code>
                <table>
                  <thead>
                    <tr>
                      <th>Attribut</th>
                      <th>Wert</th>
                      <th>Quelle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latestObservations(selectedInventoryObject).map(
                      (observation, index) => (
                        <tr
                          key={`${observation.attribute}-${observation.source_key}-${index}`}
                        >
                          <td>
                            {inventoryAttributeLabels[observation.attribute] ??
                              observation.attribute.replaceAll('_', ' ')}
                          </td>
                          <td>
                            <strong>
                              {displayInventoryValue(
                                observation.value,
                                observation.unit,
                              )}
                            </strong>
                          </td>
                          <td>
                            <span className="evidence-source">
                              {sourceLabel(observation.source_key)}
                            </span>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </>
            ) : (
              <div className="catalog-empty">Objekt auswählen</div>
            )}
          </div>
        </div>
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
        const haystack = normalizeSearch(
          `${station.name} ${station.station_number} ${station.eva ?? ''} ${station.ril ?? ''}`,
        );
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
          const latitude = Number(candidate.latitude),
            longitude = Number(candidate.longitude);
          return Number.isFinite(latitude) && Number.isFinite(longitude)
            ? [
                {
                  id: `stada-${candidate.station_number}`,
                  name: candidate.name,
                  latitude,
                  longitude,
                },
              ]
            : [];
        });
        setStations(mapped.length ? mapped : MAJOR);
        setMessage(
          `${mapped.length.toLocaleString('de-DE')} DB-Bahnhöfe werden auf der Karte angezeigt.`,
        );
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== 'AbortError')
          setMessage('Die DB-Stationsliste konnte nicht geladen werden.');
      })
      .finally(() => setSearching(false));
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!el.current || map.current) return;
    void import('leaflet').then((L) => {
      if (!el.current || map.current) return;
      map.current = L.map(el.current, {
        minZoom: 5,
        maxZoom: 18,
        preferCanvas: true,
      }).setView([51.15, 10.45], 6);
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
          radius: 2.25,
          color: '#fff',
          weight: 0.75,
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
    const latitude = Number(candidate.latitude),
      longitude = Number(candidate.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      setMessage(`${candidate.name} hat in StaDa keine Kartenkoordinaten.`);
      return;
    }
    const station: Station = {
      id: `stada-${candidate.station_number}`,
      name: candidate.name,
      latitude,
      longitude,
    };
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
          <p>
            DB-Bahnhof eingeben; die StaDa-Liste wird mit jedem Buchstaben
            eingegrenzt.
          </p>
        </div>
        <div className="station-picker">
          <form onSubmit={search}>
            <Search size={17} />
            <input
              value={query}
              onFocus={() => setShowResults(Boolean(query.trim()))}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowResults(Boolean(e.target.value.trim()));
              }}
              placeholder="DB-Bahnhof suchen, z. B. Kassel"
              autoComplete="off"
            />
            <button disabled={searching || !filteredStations.length}>
              {searching ? 'Lade …' : 'Auswählen'}
            </button>
          </form>
          {showResults ? (
            <div
              className="station-picker-results"
              role="listbox"
              aria-label="DB-Stationsliste"
            >
              {filteredStations.length ? (
                filteredStations.map((station) => (
                  <button
                    type="button"
                    role="option"
                    key={station.station_number}
                    onClick={() => chooseStation(station)}
                  >
                    <TrainFront size={15} />
                    <span>{station.name}</span>
                    <small>
                      StaDa {station.station_number}
                      {station.ril ? ` · ${station.ril}` : ''}
                    </small>
                  </button>
                ))
              ) : (
                <div className="station-picker-empty">
                  Kein DB-Bahnhof gefunden
                </div>
              )}
            </div>
          ) : null}
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
