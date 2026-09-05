'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Crosshair, Database, ExternalLink, Filter, MapPinOff, RefreshCw, Satellite, Search, ShieldCheck, TrainFront, X } from 'lucide-react';
import { StationMap, type AerialReviewAnalysis, type CoordinateEdit, type StationMapPoint } from './station-map';
import { GermanyStationMap, SelectedStationMap, type Station } from './germany-station-map';

const API = 'https://rail-infrastructure-intelligence-production.up.railway.app';
type Evidence = { attribute: string; value: unknown; unit: string | null; source_key: string; provenance?: Record<string, unknown> };
type InfraObject = { object_key: string; object_type: string; parent_object_key: string | null; depth: number; observations: Evidence[] };
type Inventory = { station: string; object_count: number; objects: InfraObject[] };
type State = { station: string; object_count: number; object_types: Record<string, number>; platform_edges: string[]; equipment_types: Record<string, number>; conflict_count: number; data_gaps: { code: string; source: string }[] };
type SourceStatus = { key: string; name: string; configured: boolean; quality_class: string };
type ReferenceObservation = { attribute: string; value: unknown; unit: string | null; source_id: string; note?: string };
type ReferenceEdge = { object_id: string; track: string; observations: ReferenceObservation[] };
type ReferenceStation = { platform_edges: ReferenceEdge[]; sources: { id: string; publisher: string; source_date: string; url: string }[] };
type Coordinate = { latitude: number; longitude: number };
type CoordinateDrafts = Record<string, Coordinate>;
type AerialAnalysis = AerialReviewAnalysis & { length_delta_m?: number; provenance?: { source?: string; layer?: string } };

function currentValue(object: InfraObject, attribute: string) {
  const values = object.observations.filter((item) => item.attribute === attribute);
  return values.length ? String(values.at(-1)?.value ?? '') : null;
}

function numericValue(object: InfraObject, attribute: string) {
  const observation = object.observations.filter((item) => item.source_key === 'openstreetmap' && item.attribute === attribute).at(-1);
  const value = Number(observation?.value);
  return Number.isFinite(value) ? value : null;
}

const equipmentLabels: Record<string, string> = { PassengerInformationEquipment: 'Fahrgastinformation', ShelterEquipment: 'Wetterschutz', StaircaseEquipment: 'Treppen', LiftEquipment: 'Aufzüge' };
const typeLabels: Record<string, string> = { stop_place: 'Bahnhof', platform: 'Bahnsteig', platform_edge: 'Bahnsteigkante', entrance: 'Zugang', equipment: 'Ausstattung' };
const attributeLabels: Record<string, string> = { name: 'Bezeichnung', equipment_type: 'Ausstattungstyp', quay_type: 'Bahnsteigtyp', usable_length: 'Bahnsteignutzlänge', public_use: 'Öffentliche Nutzung', gated: 'Zugang', lighting: 'Beleuchtung', mobility_impaired_access: 'Barrierefreiheit', safe_for_guide_dog: 'Für Blindenführhund geeignet', number_of_steps: 'Stufen', fixed: 'Fest installiert', is_external: 'Außenzugang', is_entry: 'Eingang', is_exit: 'Ausgang', latitude: 'Breitengrad', longitude: 'Längengrad', operational_state: 'Betriebszustand', wheelchair: 'Rollstuhlgerecht', tactile_paving: 'Taktile Markierung', station_number: 'Stationsnummer', uic_ref: 'OSM-UIC-Referenz' };
const filters = ['all', 'platform', 'platform_edge', 'entrance', 'equipment'] as const;
const gapLabels: Record<string, { title: string; text: string }> = {
  station_coordinates_missing: { title: 'Stationskoordinaten fehlen', text: 'OpenStation liefert aktuell keinen Standortpunkt für den Bahnhof.' },
  entrance_coordinates_missing: { title: 'Zugang nicht verortet', text: 'Der Bahnhofsvorplatz ist erfasst, aber ohne Koordinaten.' },
  lift_data_missing: { title: 'Keine Aufzugsdaten', text: 'In der aktuellen NeTEx-Lieferung sind keine Aufzüge enthalten.' },
};

export default function Home() {
  const [state, setState] = useState<State | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [reference, setReference] = useState<ReferenceStation | null>(null);
  const [error, setError] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<(typeof filters)[number]>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusObjectKey, setFocusObjectKey] = useState<string | null>(null);
  const [coordinateEdit, setCoordinateEdit] = useState<CoordinateEdit | null>(null);
  const [coordinateDrafts, setCoordinateDrafts] = useState<CoordinateDrafts>({});
  const [aerialReviewRequest, setAerialReviewRequest] = useState<{ objectKey: string; nonce: number; coordinateType?: 'start' | 'end'; analysis?: AerialAnalysis } | null>(null);
  const [aerialResults, setAerialResults] = useState<Record<string, AerialAnalysis>>({});
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);

  async function load() {
    setRefreshing(true); setError(false);
    try {
      const [stateResponse, inventoryResponse, sourceResponse, referenceResponse] = await Promise.all([
        fetch(`${API}/stations/friedberg-hess/state/openstation`, { cache: 'no-store' }),
        fetch(`${API}/stations/friedberg-hess/infrastructure/openstation`, { cache: 'no-store' }),
        fetch(`${API}/stations/friedberg-hess/source-status`, { cache: 'no-store' }),
        fetch(`${API}/stations/friedberg-hess`, { cache: 'no-store' }),
      ]);
      if (!stateResponse.ok || !inventoryResponse.ok || !sourceResponse.ok || !referenceResponse.ok) throw new Error('API unavailable');
      const sourceData = await sourceResponse.json() as { sources: SourceStatus[] };
      setState(await stateResponse.json()); setInventory(await inventoryResponse.json()); setSources(sourceData.sources); setReference(await referenceResponse.json()); setUpdated(new Date());
    } catch { setError(true); } finally { setRefreshing(false); }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => {
    try { setCoordinateDrafts(JSON.parse(localStorage.getItem('friedberg-coordinate-drafts') ?? '{}') as CoordinateDrafts); } catch { setCoordinateDrafts({}); }
  }, []);
  const platforms = useMemo(() => {
    if (!inventory) return [];
    return inventory.objects.filter((item) => item.object_type === 'platform').map((platform) => ({
      ...platform, name: currentValue(platform, 'name') ?? 'Bahnsteig',
      edges: inventory.objects.filter((edge) => edge.object_type === 'platform_edge' && edge.parent_object_key === platform.object_key).map((edge) => currentValue(edge, 'name')).filter(Boolean) as string[],
    }));
  }, [inventory]);
  const filteredObjects = useMemo(() => {
    if (!inventory) return [];
    const needle = query.trim().toLocaleLowerCase('de-DE');
    return inventory.objects.filter((item) => {
      if (typeFilter !== 'all' && item.object_type !== typeFilter) return false;
      if (!needle) return true;
      return [item.object_key, ...item.observations.map((entry) => String(entry.value))]
        .some((value) => value.toLocaleLowerCase('de-DE').includes(needle));
    });
  }, [inventory, query, typeFilter]);
  const mapPoints = useMemo<StationMapPoint[]>(() => {
    if (!inventory) return [];
    const points: StationMapPoint[] = [];
    inventory.objects.forEach((item) => {
      const rawTitle = currentValue(item, 'name') ?? equipmentLabels[currentValue(item, 'equipment_type') ?? ''] ?? typeLabels[item.object_type] ?? item.object_type;
      const title = item.object_type === 'platform_edge' && !/^Gleis\s/i.test(rawTitle) ? `Gleis ${rawTitle}` : rawTitle;
      const latitude = numericValue(item, 'latitude');
      const longitude = numericValue(item, 'longitude');
      if (latitude !== null && longitude !== null) points.push({ id: `${item.object_key}:position`, objectKey: item.object_key, latitude, longitude, title, objectType: item.object_type, coordinateType: 'position' });
      (['start_coordinates', 'end_coordinates'] as const).forEach((attribute) => {
        const observation = item.observations.filter((entry) => entry.source_key === 'openstreetmap' && entry.attribute === attribute).at(-1);
        const coordinate = observation?.value as { latitude?: unknown; longitude?: unknown } | undefined;
        const pointLatitude = Number(coordinate?.latitude);
        const pointLongitude = Number(coordinate?.longitude);
        const coordinateType = attribute === 'start_coordinates' ? 'start' : 'end';
        const draft = coordinateDrafts[`${item.object_key}:${coordinateType}`];
        if (draft) points.push({ id: `${item.object_key}:${attribute}:draft`, objectKey: item.object_key, latitude: draft.latitude, longitude: draft.longitude, title, objectType: item.object_type, coordinateType, isDraft: true });
        else if (Number.isFinite(pointLatitude) && Number.isFinite(pointLongitude)) points.push({ id: `${item.object_key}:${attribute}`, objectKey: item.object_key, latitude: pointLatitude, longitude: pointLongitude, title, objectType: item.object_type, coordinateType });
      });
    });
    return points;
  }, [coordinateDrafts, inventory]);
  const selectedObject = inventory?.objects.find((item) => item.object_key === selectedKey) ?? filteredObjects[0] ?? null;
  const handleCoordinateChange = useCallback((edit: CoordinateEdit, latitude: number, longitude: number) => {
    const key = `${edit.objectKey}:${edit.coordinateType}`;
    setCoordinateDrafts((current) => {
      const next = { ...current, [key]: { latitude, longitude } };
      localStorage.setItem('friedberg-coordinate-drafts', JSON.stringify(next));
      return next;
    });
    const track = edit.title.replace(/^Gleis\s+/i, '');
    const analysis = aerialResults[track];
    const features = edit.coordinateType === 'start' ? analysis?.start_features : analysis?.end_features;
    void fetch(`${API}/stations/friedberg-hess/aerial-analysis/training-feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track, endpoint: edit.coordinateType, accepted: false, features: features ?? {},
        corrected_coordinate: { latitude, longitude } }),
    });
    setCoordinateEdit(null);
  }, [aerialResults]);
  const applyCoordinateSuggestion = useCallback((objectKey: string, start: Coordinate, end: Coordinate) => {
    setCoordinateDrafts((current) => {
      const next = { ...current, [`${objectKey}:start`]: start, [`${objectKey}:end`]: end };
      localStorage.setItem('friedberg-coordinate-drafts', JSON.stringify(next));
      return next;
    });
  }, []);
  const focusPlatform = useCallback((objectKey: string) => {
    setSelectedKey(objectKey);
    setFocusObjectKey(objectKey);
    document.getElementById('station-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (selectedStation && !selectedStation.available) return <main className="min-h-screen bg-background text-foreground"><header className="border-b border-border bg-[#071b2b] text-white"><div className="mx-auto flex max-w-[1440px] items-center gap-3 px-5 py-4 lg:px-10"><span className="grid h-10 w-10 place-items-center rounded-md bg-[#f5a623] text-[#071b2b]"><TrainFront size={22}/></span><div><p className="text-sm font-semibold tracking-wide">DB INFRASTRUKTURDATEN</p><p className="text-xs text-slate-300">Deutschlandweite Bahnhofsauswahl</p></div></div></header><div className="mx-auto max-w-[1440px] px-5 py-7 lg:px-10 lg:py-10"><GermanyStationMap onSelect={setSelectedStation}/><SelectedStationMap station={selectedStation} onBack={() => setSelectedStation(null)}/></div></main>;

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-[#071b2b] text-white"><div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 lg:px-10">
      <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-md bg-[#f5a623] text-[#071b2b]"><TrainFront size={22}/></span><div><p className="text-sm font-semibold tracking-wide">DB INFRASTRUKTURDATEN</p><p className="text-xs text-slate-300">Deutschlandweiter Infrastruktur-Viewer</p></div></div>
      <button onClick={load} disabled={refreshing} className="flex min-h-11 items-center gap-2 rounded-md border border-white/20 px-4 text-sm font-medium hover:bg-white/10 disabled:opacity-60"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''}/>Aktualisieren</button>
    </div></header>
    <div className="mx-auto max-w-[1440px] px-5 py-7 lg:px-10 lg:py-10">
      <section className="mb-7 flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><p className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-[#b25b18]">Infrastruktur-Viewer</p><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Bahnhof-Infrastruktur Deutschland</h1><p className="mt-2 text-base text-muted-foreground">Bahnhöfe auswählen und quellenbelegte Infrastrukturdaten prüfen</p></div><div className="flex items-center gap-2 text-sm text-muted-foreground"><Database size={16}/>{updated ? `Abgerufen ${updated.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'Live-Daten werden geladen'}</div></section>
      {error ? <section className="mb-7 rounded-lg border border-red-300 bg-red-50 p-5 text-red-900"><p className="font-semibold">Datenquelle momentan nicht erreichbar</p><p className="mt-1 text-sm">Bitte in einigen Sekunden erneut aktualisieren.</p></section> : null}
      <GermanyStationMap onSelect={(station) => { setSelectedStation(station); if (station.available) document.getElementById('station-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}/>
      <StationMap points={mapPoints} focusObjectKey={focusObjectKey} coordinateEdit={coordinateEdit} aerialReviewRequest={aerialReviewRequest} aerialResults={aerialResults} onSelect={setSelectedKey} onNavigateEndpoint={(objectKey, analysis, coordinateType) => setAerialReviewRequest({ objectKey, analysis, coordinateType, nonce: Date.now() })} onBeginCoordinateEdit={setCoordinateEdit} onCoordinateChange={handleCoordinateChange} onCancelEdit={() => setCoordinateEdit(null)}/>
      <PlatformDataTable reference={reference} inventory={inventory} coordinateDrafts={coordinateDrafts} aerialResults={aerialResults} onResetAerialResults={() => setAerialResults({})} onAerialResult={(objectKey, result) => setAerialResults((current) => ({ ...current, [objectKey]: result }))} onFocus={focusPlatform} onAerialReview={(objectKey, analysis, coordinateType) => { focusPlatform(objectKey); setAerialReviewRequest({ objectKey, analysis, coordinateType, nonce: Date.now() }); }} onApplySuggestion={applyCoordinateSuggestion} onEdit={(edit) => { setCoordinateEdit(edit); focusPlatform(edit.objectKey); }}/>
      <section className="mb-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Infrastrukturobjekte" value={state?.object_count} accent="navy"/><Metric label="Bahnsteigkanten" value={state?.object_types.platform_edge} accent="orange"/><Metric label="Ausstattung" value={state?.object_types.equipment} accent="steel"/><Metric label="Aktuelle Konflikte" value={state?.conflict_count} accent="green"/></section>
      <section className="mb-7 rounded-xl border border-border bg-card shadow-sm"><div className="flex flex-col justify-between gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:px-6"><div><h2 className="text-lg font-bold">Datenquellen</h2><p className="mt-1 text-sm text-muted-foreground">Aktive Verbindungen und Qualitätsklasse</p></div><span className="text-sm font-semibold text-[#176944]">{sources.filter((source) => source.configured).length} von {sources.length || 6} verbunden</span></div><div className="source-grid">{sources.map((source) => <div className="source-row" key={source.key}><span className={`source-indicator ${source.configured ? 'source-active' : 'source-pending'}`}/><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{source.name}</p><p className="mt-1 text-xs text-muted-foreground">Qualitätsklasse {source.quality_class}</p></div><span className={source.configured ? 'source-state-active' : 'source-state-pending'}>{source.configured ? 'Aktiv' : 'Zugang fehlt'}</span></div>)}</div></section>
      <div className="grid gap-7 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.75fr)]">
        <section className="rounded-xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between border-b border-border px-5 py-4 sm:px-6"><div><h2 className="text-lg font-bold">Bahnsteigübersicht</h2><p className="mt-1 text-sm text-muted-foreground">Bahnsteige und zugeordnete Gleise aus NeTEx</p></div><span className="status-ok"><ShieldCheck size={15}/>Identität geprüft</span></div><div className="space-y-3 p-4 sm:p-6">{platforms.length ? platforms.map((platform, index) => <PlatformRow key={platform.object_key} name={platform.name} edges={platform.edges} index={index + 1}/>) : [1,2,3,4,5].map((n) => <div key={n} className="h-[72px] animate-pulse rounded-lg bg-muted"/>)}</div></section>
        <div className="space-y-7"><section className="rounded-xl border border-border bg-card shadow-sm"><div className="border-b border-border px-5 py-4"><h2 className="text-lg font-bold">Ausstattung</h2><p className="mt-1 text-sm text-muted-foreground">Tatsächlich in NeTEx vorhandene Elemente</p></div><div className="divide-y divide-border px-5">{state ? Object.entries(state.equipment_types).map(([type, count]) => <div key={type} className="flex items-center justify-between py-4"><span className="text-sm font-medium">{equipmentLabels[type] ?? type}</span><strong className="tabular-nums">{count}</strong></div>) : [1,2,3].map((n) => <div key={n} className="my-3 h-8 animate-pulse rounded bg-muted"/>)}</div></section>
          <section className="rounded-xl border border-[#e9c9ad] bg-[#fff9f3] shadow-sm"><div className="flex items-center gap-2 border-b border-[#efd8c5] px-5 py-4 text-[#87420f]"><AlertTriangle size={18}/><h2 className="text-lg font-bold">Datenlücken</h2></div><div className="space-y-4 p-5">{state?.data_gaps.map((gap) => { const copy = gapLabels[gap.code] ?? { title: gap.code, text: gap.source }; return <div key={gap.code} className="flex gap-3"><MapPinOff size={17} className="mt-0.5 shrink-0 text-[#b25b18]"/><div><p className="text-sm font-semibold">{copy.title}</p><p className="mt-0.5 text-sm leading-5 text-[#73543d]">{copy.text}</p></div></div>; })}</div></section>
        </div>
      </div>
      <section className="mt-7 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-5 py-5 sm:px-6"><div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center"><div><h2 className="text-lg font-bold">Objektkatalog</h2><p className="mt-1 text-sm text-muted-foreground">Infrastruktur durchsuchen und Evidenz im Detail prüfen</p></div><label className="search-box"><Search size={17}/><span className="sr-only">Objekte durchsuchen</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, Gleis oder NeTEx-ID"/>{query ? <button aria-label="Suche löschen" onClick={() => setQuery('')}><X size={16}/></button> : null}</label></div>
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Objekttyp filtern"><Filter size={16} className="mt-2 text-muted-foreground"/>{filters.map((filter) => <button key={filter} aria-pressed={typeFilter === filter} onClick={() => setTypeFilter(filter)} className="filter-button">{filter === 'all' ? 'Alle' : typeLabels[filter]}{filter !== 'all' && state ? <span>{state.object_types[filter] ?? 0}</span> : null}</button>)}</div>
        </div>
        <div className="grid min-h-[520px] lg:grid-cols-[minmax(300px,.8fr)_minmax(0,1.4fr)]">
          <div className="object-list" role="list" aria-label={`${filteredObjects.length} gefundene Objekte`}>
            <p className="sticky top-0 z-10 border-b border-border bg-[#f7f9fa] px-5 py-3 text-sm font-semibold text-muted-foreground">{filteredObjects.length} {filteredObjects.length === 1 ? 'Objekt' : 'Objekte'}</p>
            {filteredObjects.map((item) => { const title = currentValue(item, 'name') ?? equipmentLabels[currentValue(item, 'equipment_type') ?? ''] ?? typeLabels[item.object_type] ?? item.object_type; const active = selectedObject?.object_key === item.object_key; return <button role="listitem" key={item.object_key} onClick={() => setSelectedKey(item.object_key)} className="object-row" aria-current={active ? 'true' : undefined}><span className={`type-dot type-${item.object_type}`}/><span className="min-w-0 flex-1 text-left"><strong className="block truncate text-sm">{title}</strong><span className="mt-1 block text-xs text-muted-foreground">{typeLabels[item.object_type] ?? item.object_type} · {item.observations.length} Werte</span></span><ChevronRight size={17} className="text-muted-foreground"/></button>; })}
            {!filteredObjects.length ? <div className="p-8 text-center"><Search size={24} className="mx-auto text-muted-foreground"/><p className="mt-3 font-semibold">Keine Objekte gefunden</p><button className="mt-2 text-sm font-semibold text-[#0b5278] hover:underline" onClick={() => { setQuery(''); setTypeFilter('all'); }}>Filter zurücksetzen</button></div> : null}
          </div>
          <ObjectDetail object={selectedObject}/>
        </div>
      </section>
      <footer className="mt-8 flex flex-col justify-between gap-3 border-t border-border pt-5 text-sm text-muted-foreground sm:flex-row sm:items-center"><span>Alle Werte bleiben mit Quelle und Historie erhalten.</span><a className="inline-flex items-center gap-1 font-semibold text-[#0b5278] hover:underline" href={`${API}/docs`} target="_blank" rel="noreferrer">API-Dokumentation <ExternalLink size={14}/></a></footer>
    </div>
  </main>;
}

function Metric({ label, value, accent }: { label: string; value?: number; accent: string }) { return <div className={`metric metric-${accent}`}><p>{label}</p><strong>{value ?? '–'}</strong></div>; }
function PlatformRow({ name, edges, index }: { name: string; edges: string[]; index: number }) { return <div className="platform-row"><div className="platform-index">B{index}</div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-muted-foreground">{name}</p><div className="mt-2 flex flex-wrap gap-2">{edges.map((edge) => <span key={edge} className="track-pill">Gleis {edge}</span>)}</div></div><div className="hidden h-1 w-20 rounded-full bg-[#f5a623] sm:block"/></div>; }

function PlatformDataTable({ reference, inventory, coordinateDrafts, aerialResults, onResetAerialResults, onAerialResult, onFocus, onAerialReview, onApplySuggestion, onEdit }: { reference: ReferenceStation | null; inventory: Inventory | null; coordinateDrafts: CoordinateDrafts; aerialResults: Record<string, AerialAnalysis>; onResetAerialResults: () => void; onAerialResult: (objectKey: string, result: AerialAnalysis) => void; onFocus: (objectKey: string) => void; onAerialReview: (objectKey: string, analysis?: AerialAnalysis, coordinateType?: 'start' | 'end') => void; onApplySuggestion: (objectKey: string, start: Coordinate, end: Coordinate) => void; onEdit: (edit: CoordinateEdit) => void }) {
  const [osmConfirmed, setOsmConfirmed] = useState<Record<string, boolean>>({});
  const [aerialLoading, setAerialLoading] = useState<Record<string, boolean>>({});
  const [platformCheckEnabled, setPlatformCheckEnabled] = useState(false);
  useEffect(() => {
    try { setOsmConfirmed(JSON.parse(localStorage.getItem('friedberg-osm-confirmations') ?? '{}') as Record<string, boolean>); } catch { setOsmConfirmed({}); }
  }, []);
  const toggleOsmConfirmation = (objectKey: string) => {
    setOsmConfirmed((current) => {
      const next = { ...current, [objectKey]: !current[objectKey] };
      localStorage.setItem('friedberg-osm-confirmations', JSON.stringify(next));
      return next;
    });
  };
  const value = (edge: ReferenceEdge, attribute: string) => edge.observations.find((item) => item.attribute === attribute);
  const osmValue = (edge: ReferenceEdge, attribute: string) => inventory?.objects.find((item) => item.object_key === edge.object_id)?.observations.filter((item) => item.attribute === attribute && item.source_key === 'openstreetmap').at(-1);
  const rinfValue = (edge: ReferenceEdge) => inventory?.objects.find((item) => item.object_key === edge.object_id)?.observations.filter((item) => item.attribute === 'usable_length' && item.source_key === 'era-rinf').at(-1);
  const format = (observation?: ReferenceObservation | Evidence) => {
    if (!observation) return null;
    if (typeof observation.value === 'object' && observation.value) {
      const coordinate = observation.value as { latitude?: number; longitude?: number };
      return `${coordinate.latitude?.toFixed(6)}, ${coordinate.longitude?.toFixed(6)}`;
    }
    return `${String(observation.value)}${observation.unit ? ` ${observation.unit}` : ''}`;
  };
  const cell = (observation: ReferenceObservation | Evidence | undefined, source: string) => observation ? <div className="data-value"><strong>{format(observation)}</strong><span>{source}</span></div> : <span className="data-missing">Nicht geliefert</span>;
  const coordinateValue = (edge: ReferenceEdge, coordinateType: 'start' | 'end') => {
    const observation = osmValue(edge, coordinateType === 'start' ? 'start_coordinates' : 'end_coordinates');
    const value = observation?.value as { latitude?: unknown; longitude?: unknown } | undefined;
    const latitude = Number(value?.latitude);
    const longitude = Number(value?.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  };
  const distanceMetres = (start: Coordinate, end: Coordinate) => {
    const radians = (degrees: number) => degrees * Math.PI / 180;
    const latitudeDelta = radians(end.latitude - start.latitude);
    const longitudeDelta = radians(end.longitude - start.longitude);
    const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(start.latitude)) * Math.cos(radians(end.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };
  const proposedLength = (edge: ReferenceEdge) => {
    const startDraft = coordinateDrafts[`${edge.object_id}:start`];
    const endDraft = coordinateDrafts[`${edge.object_id}:end`];
    if (!startDraft && !endDraft) return null;
    const start = startDraft ?? coordinateValue(edge, 'start');
    const end = endDraft ?? coordinateValue(edge, 'end');
    return start && end ? distanceMetres(start, end) : null;
  };
  const activeCoordinate = (edge: ReferenceEdge, coordinateType: 'start' | 'end') => coordinateDrafts[`${edge.object_id}:${coordinateType}`] ?? coordinateValue(edge, coordinateType);
  const pairedTracks: Record<string, string> = { '2': '4', '4': '2', '5': '7', '7': '5', '8': '10', '10': '8', '11': '12', '12': '11' };
  const osmPlausibility = (edge: ReferenceEdge) => {
    const start = activeCoordinate(edge, 'start');
    const end = activeCoordinate(edge, 'end');
    const geometryLength = proposedLength(edge) ?? Number(osmValue(edge, 'construction_length')?.value);
    const reasons: string[] = [];
    let level: 'ok' | 'check' | 'high' = 'ok';
    if (!start || !end || !Number.isFinite(geometryLength) || geometryLength <= 0) return { level: 'high' as const, reasons: ['Endpunkte oder Linienlänge fehlen'] };
    const directDistance = distanceMetres(start, end);
    const straightness = directDistance / geometryLength;
    if (geometryLength < 80) { level = 'high'; reasons.push('OSM-Bahnsteigkante ungewöhnlich kurz'); }
    if (straightness < 0.9 || straightness > 1.02) { level = level === 'high' ? 'high' : 'check'; reasons.push('Linienlänge und Endpunktdistanz sind nicht stimmig'); }
    const partnerTrack = pairedTracks[edge.track];
    const partner = reference?.platform_edges.find((item) => item.track === partnerTrack);
    const partnerStart = partner ? activeCoordinate(partner, 'start') : null;
    const partnerEnd = partner ? activeCoordinate(partner, 'end') : null;
    if (partner && partnerStart && partnerEnd) {
      const sameDirection = [distanceMetres(start, partnerStart), distanceMetres(end, partnerEnd)];
      const oppositeDirection = [distanceMetres(start, partnerEnd), distanceMetres(end, partnerStart)];
      const matched = sameDirection[0] + sameDirection[1] <= oppositeDirection[0] + oppositeDirection[1] ? sameDirection : oppositeDirection;
      const largestEndOffset = Math.max(...matched);
      if (largestEndOffset > 35) { level = 'high'; reasons.push(`Endlage weicht deutlich von Gleis ${partnerTrack} ab`); }
      else if (largestEndOffset > 15) { level = level === 'high' ? 'high' : 'check'; reasons.push(`Endlage weicht von Gleis ${partnerTrack} ab`); }
    }
    return { level, reasons: reasons.length ? reasons : ['OSM-Geometrie intern plausibel'] };
  };
  const runPlatformChecks = async () => {
    if (!reference || platformCheckEnabled) return;
    setPlatformCheckEnabled(true);
    onResetAerialResults();
    const tracks = reference.platform_edges.map((edge) => edge.track);
    setAerialLoading(Object.fromEntries(tracks.map((track) => [track, true])));
    for (let index = 0; index < tracks.length; index += 3) {
      await Promise.all(tracks.slice(index, index + 3).map(async (track) => {
        try {
          const response = await fetch(`${API}/stations/friedberg-hess/aerial-analysis/osm?track=${encodeURIComponent(track)}`, { cache: 'no-store' });
          if (!response.ok) throw new Error('Luftbildanalyse nicht erreichbar');
          const result = await response.json() as AerialAnalysis;
          onAerialResult(track, result);
        } catch {
          onAerialResult(track, { status: 'insufficient_evidence', confidence: 0, reason: 'Keine eindeutige automatische Auswertung verfügbar', advisory_only: true });
        } finally {
          setAerialLoading((current) => ({ ...current, [track]: false }));
        }
      }));
    }
  };
  const checkedCount = Object.keys(aerialResults).length;
  const loadingCount = Object.values(aerialLoading).filter(Boolean).length;
  const comparison = (edge: ReferenceEdge) => {
    const osm = proposedLength(edge) ?? Number(osmValue(edge, 'construction_length')?.value);
    const db = Number(value(edge, 'net_construction_length')?.value);
    if (!Number.isFinite(osm) || !Number.isFinite(db) || db <= 0) return null;
    const delta = osm - db;
    const percent = Math.abs(delta) / db * 100;
    return { delta, percent, level: percent <= 5 ? 'low' : percent <= 15 ? 'check' : 'high' } as const;
  };
  const comparisons = reference?.platform_edges.map(comparison).filter(Boolean) ?? [];
  const osmGeometryCell = (edge: ReferenceEdge) => {
    const observation = osmValue(edge, 'construction_length');
    const osmType = String(observation?.provenance?.osm_type ?? 'way');
    const osmId = observation?.provenance?.osm_id;
    const updatedLength = proposedLength(edge);
    const plausibility = osmPlausibility(edge);
    const aerial = aerialResults[edge.track];
    return <div className="data-value">{updatedLength !== null ? <div className="updated-length"><span className="updated-badge">Aktualisiert</span><strong>{updatedLength.toFixed(1)} m</strong><span>Neue OSM-Länge · Grundlage der Abweichung</span></div> : null}<strong>{format(observation) ?? 'Nicht geliefert'}</strong><span>OSM · bisherige Ist-Geometrie</span>{plausibility.level !== 'ok' ? <div className={`osm-plausibility osm-plausibility-${plausibility.level}`}><strong>{plausibility.level === 'check' ? 'OSM prüfen' : 'OSM auffällig'}</strong>{plausibility.reasons.map((reason) => <span key={reason}>{reason}</span>)}{aerialLoading[edge.track] ? <span className="aerial-loading">Amtliches Luftbild wird automatisch ausgewertet …</span> : null}{aerial ? <div className={`aerial-result aerial-result-${aerial.status}`}><strong>Amtliche Luftbildprüfung: {aerial.status === 'plausible' ? 'plausibel' : aerial.status === 'check' ? 'prüfen' : aerial.status === 'high' ? 'auffällig' : 'keine belastbare Aussage'}</strong>{aerial.candidate_length_m !== undefined ? <span>Erkannter Vorschlag: {aerial.candidate_length_m.toFixed(1)} m · Konfidenz {Math.round(aerial.confidence * 100)}%</span> : <span>{aerial.reason}</span>}{aerial.maximum_endpoint_shift_m !== undefined ? <span>Größte Endpunktverschiebung: {aerial.maximum_endpoint_shift_m.toFixed(1)} m</span> : null}{aerial.candidate_start && aerial.candidate_end && aerial.status !== 'plausible' ? <button type="button" onClick={() => onApplySuggestion(edge.object_id, aerial.candidate_start!, aerial.candidate_end!)}>Vorschlag als Prüfpunkte übernehmen</button> : null}</div> : null}<div className="aerial-endpoint-jumps"><button type="button" onClick={() => onAerialReview(edge.object_id, aerial, 'start')}><Satellite size={13}/>Anfang prüfen</button><button type="button" onClick={() => onAerialReview(edge.object_id, aerial, 'end')}><Satellite size={13}/>Ende prüfen</button></div></div> : null}{osmId ? <a className="source-data-link" href={`https://www.openstreetmap.org/${osmType}/${String(osmId)}`} target="_blank" rel="noreferrer">Original OSM {osmType} {String(osmId)} <ExternalLink size={11}/></a> : null}</div>;
  };
  const usableLengthCell = (edge: ReferenceEdge) => {
    const rinf = rinfValue(edge);
    if (!rinf) return <div className="data-value"><span className="data-missing">Nicht in RINF zugeordnet</span><span>{edge.track === '1a' ? 'Gleis 49 bleibt separat' : 'ERA RINF'}</span></div>;
    const netLength = Number(value(edge, 'net_construction_length')?.value);
    const rinfLength = Number(rinf.value);
    const shorterBy = netLength - rinfLength;
    const needsReview = Number.isFinite(shorterBy) && shorterBy > 0 && shorterBy < 5;
    return <div className="data-value"><strong>{format(rinf)}</strong><span>ERA RINF · gültig 2026</span>{needsReview ? <span className="automatic-check">Nur {shorterBy.toFixed(1)} m kürzer als Nettobaulänge</span> : null}</div>;
  };
  const coordinateCell = (edge: ReferenceEdge, coordinateType: 'start' | 'end') => {
    const attribute = coordinateType === 'start' ? 'start_coordinates' : 'end_coordinates';
    const draft = coordinateDrafts[`${edge.object_id}:${coordinateType}`];
    const observation = osmValue(edge, attribute);
    return <div className="coordinate-cell">{draft ? <div className="updated-coordinate"><span className="updated-badge">Aktualisiert</span><strong>{draft.latitude.toFixed(6)}, {draft.longitude.toFixed(6)}</strong><span>Aktive Koordinate</span></div> : null}<div className="data-value"><strong>{format(observation) ?? 'Nicht geliefert'}</strong><span>OpenStreetMap · bisheriger Istwert</span></div><button type="button" onClick={() => onEdit({ objectKey: edge.object_id, coordinateType, title: `Gleis ${edge.track}` })}><Crosshair size={13}/>{coordinateType === 'start' ? 'Anfang' : 'Ende'} anpassen</button></div>;
  };
  return <section className="mt-7 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
    <div className="flex flex-col justify-between gap-3 border-b border-border px-5 py-4 lg:flex-row lg:items-end sm:px-6"><div><h2 className="text-lg font-bold">Bahnsteigdaten und Plausibilitätscheck</h2><p className="mt-1 text-sm text-muted-foreground">DB-Maße gegen OSM-Geometrie; die Bildprüfung verwendet zuerst das amtliche Hessen-DOP.</p></div><div className="comparison-summary"><span className="comparison-low">{comparisons.filter((item) => item?.level === 'low').length} geringe</span><span className="comparison-check">{comparisons.filter((item) => item?.level === 'check').length} prüfen</span><span className="comparison-high">{comparisons.filter((item) => item?.level === 'high').length} auffällig</span></div></div>
    <div className="platform-check-panel">
      <div><strong>Bahnsteiganfänge und -enden prüfen</strong><span>Anfang und Ende werden unabhängig geprüft; jeder Eintrag springt direkt in den Luftbildzoom.</span></div>
      <button type="button" className={platformCheckEnabled ? 'platform-check-switch platform-check-switch-on' : 'platform-check-switch'} aria-pressed={platformCheckEnabled} disabled={platformCheckEnabled} onClick={() => void runPlatformChecks()}><span aria-hidden="true"/>{platformCheckEnabled ? loadingCount ? `Endpunktprüfung läuft (${checkedCount}/${reference?.platform_edges.length ?? 0})` : 'Endpunktprüfung abgeschlossen' : 'Endpunkte prüfen'}</button>
    </div>
    {platformCheckEnabled ? <div className="platform-check-results" aria-live="polite">
      {reference?.platform_edges.map((edge) => {
        const result = aerialResults[edge.track];
        const loading = aerialLoading[edge.track];
        const endpointStatus = (coordinateType: 'start' | 'end') => {
          if (!result) return 'Noch nicht geprüft';
          const shift = coordinateType === 'start' ? result.start_shift_m : result.end_shift_m;
          const confidence = coordinateType === 'start' ? result.start_confidence : result.end_confidence;
          if (shift === undefined) return 'Nicht eindeutig';
          const assessment = Math.abs(shift) <= 3 ? 'OSM bestätigt' : `${shift >= 0 ? '+' : ''}${shift.toFixed(1)} m`;
          return `${assessment} · ${Math.round((confidence ?? result.confidence) * 100)}%`;
        };
        return <article key={edge.track} className={`platform-check-result ${result ? `platform-check-result-${result.status}` : ''}`}>
          <button type="button" className="platform-result-track" onClick={() => onAerialReview(edge.object_id, result, 'start')}>Gleis {edge.track}</button>
          {loading ? <strong>Anfang und Ende werden unabhängig geprüft</strong> : <>
            <button type="button" className="endpoint-result-jump" onClick={() => onAerialReview(edge.object_id, result, 'start')}>
              <span><b>Anfang</b><small>Im Luftbild prüfen</small></span><strong>{endpointStatus('start')}</strong>
            </button>
            <button type="button" className="endpoint-result-jump" onClick={() => onAerialReview(edge.object_id, result, 'end')}>
              <span><b>Ende</b><small>Im Luftbild prüfen</small></span><strong>{endpointStatus('end')}</strong>
            </button>
          </>}
        </article>;
      })}
    </div> : null}
    <div className="platform-data-scroll"><table className="platform-data-table"><thead><tr><th>Gleis</th><th>Bahnsteighöhe</th><th className="length-column">Baulänge OSM</th><th>OSM-Daten bestätigt</th><th>Nettobaulänge DB</th><th>Abweichung OSM–DB</th><th className="length-column">Gleisbezogene Bahnsteignutzlänge</th><th>Anfang Geokoordinaten</th><th>Ende Geokoordinaten</th></tr></thead><tbody>
      {reference?.platform_edges.map((edge) => { const deviation = comparison(edge); const confirmed = Boolean(osmConfirmed[edge.object_id]); const dbNeedsReview = confirmed && deviation?.level === 'high'; return <tr key={edge.object_id} className={deviation?.level === 'high' ? 'row-deviation-high' : undefined}><td><button type="button" className="track-pill track-focus" onClick={() => onFocus(edge.object_id)}>Gleis {edge.track}</button></td><td>{cell(osmValue(edge, 'platform_height'), 'OpenStreetMap')}</td><td className="length-column">{osmGeometryCell(edge)}</td><td><button type="button" className={confirmed ? 'osm-confirm osm-confirmed' : 'osm-confirm'} aria-pressed={confirmed} onClick={() => toggleOsmConfirmation(edge.object_id)}><ShieldCheck size={15}/>{confirmed ? 'Bestätigt' : 'Bestätigen'}</button></td><td><div className={dbNeedsReview ? 'db-length-review' : undefined}>{cell(value(edge, 'net_construction_length'), 'DB InfraGO')}{dbNeedsReview ? <span>DB-Nettobaulänge anzupassen: bestätigte OSM-Länge weicht wesentlich ab</span> : null}</div></td><td>{deviation ? <button type="button" className={`deviation deviation-${deviation.level} deviation-button`} onClick={() => onFocus(edge.object_id)} title="Auf der Karte anzeigen"><strong>OSM {Math.abs(deviation.delta).toFixed(1)} m {deviation.delta >= 0 ? 'länger' : 'kürzer'}</strong><span>als DB · {deviation.percent.toFixed(1)}% · {deviation.level === 'low' ? 'gering' : deviation.level === 'check' ? 'prüfen' : 'auffällig'}</span></button> : <span className="data-missing">Nicht vergleichbar</span>}</td><td className="length-column">{usableLengthCell(edge)}</td><td>{coordinateCell(edge, 'start')}</td><td>{coordinateCell(edge, 'end')}</td></tr>; })}
      {!reference ? Array.from({ length: 4 }, (_, index) => <tr key={index}><td colSpan={9}><div className="h-8 animate-pulse rounded bg-muted"/></td></tr>) : null}
    </tbody></table></div>
    <div className="platform-data-note"><AlertTriangle size={16}/><p>Der Hinweis zur gleisbezogenen Bahnsteignutzlänge erscheint ausschließlich, wenn die RINF-Nutzlänge weniger als 5,0 m unter der DB-Nettobaulänge liegt. Er ändert keine Quelle. Gleis 49 wird nicht als 1a übernommen.</p></div>
  </section>;
}

function ObjectDetail({ object }: { object: InfraObject | null }) {
  if (!object) return <div className="grid place-items-center p-8 text-center text-muted-foreground"><p>Wählen Sie ein Objekt aus.</p></div>;
  const current = new Map<string, Evidence>();
  object.observations.forEach((entry) => current.set(`${entry.attribute}:${entry.source_key}`, entry));
  const evidence = [...current.values()];
  const title = currentValue(object, 'name') ?? equipmentLabels[currentValue(object, 'equipment_type') ?? ''] ?? typeLabels[object.object_type] ?? object.object_type;
  const netexId = evidence.find((entry) => entry.provenance?.netex_id)?.provenance?.netex_id;
  return <article className="detail-panel"><div className="border-b border-border pb-5"><span className="detail-type">{typeLabels[object.object_type] ?? object.object_type}</span><h3 className="mt-3 text-2xl font-bold tracking-tight">{title}</h3>{netexId ? <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{String(netexId)}</p> : null}</div>
    <div className="mt-5 overflow-hidden rounded-lg border border-border"><table className="evidence-table"><thead><tr><th>Attribut</th><th>Wert</th><th>Quelle</th></tr></thead><tbody>{evidence.map((entry) => <tr key={`${entry.attribute}:${entry.source_key}`}><td>{attributeLabels[entry.attribute] ?? entry.attribute.replaceAll('_', ' ')}</td><td className="font-medium">{typeof entry.value === 'boolean' ? (entry.value ? 'Ja' : 'Nein') : String(entry.value)}{entry.unit ? ` ${entry.unit}` : ''}</td><td><span className="source-chip">{{'db-infrago-openstation-netex': 'DB OpenStation', 'db-infrago-stada': 'DB StaDa', 'db-infrago-fasta': 'DB FaSta', 'era-rinf': 'ERA RINF', openstreetmap: 'OpenStreetMap'}[entry.source_key] ?? entry.source_key}</span></td></tr>)}</tbody></table></div>
    <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Database size={15}/>Quellenwerte werden nicht überschrieben.</p>
  </article>;
}
