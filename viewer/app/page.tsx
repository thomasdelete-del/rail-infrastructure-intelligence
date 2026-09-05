'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, Database, ExternalLink, Filter, MapPinOff, RefreshCw, Search, ShieldCheck, TrainFront, X } from 'lucide-react';

const API = 'https://rail-infrastructure-intelligence-production.up.railway.app';
type Evidence = { attribute: string; value: unknown; unit: string | null; source_key: string; provenance?: Record<string, unknown> };
type InfraObject = { object_key: string; object_type: string; parent_object_key: string | null; depth: number; observations: Evidence[] };
type Inventory = { station: string; object_count: number; objects: InfraObject[] };
type State = { station: string; object_count: number; object_types: Record<string, number>; platform_edges: string[]; equipment_types: Record<string, number>; conflict_count: number; data_gaps: { code: string; source: string }[] };
type SourceStatus = { key: string; name: string; configured: boolean; quality_class: string };
type ReferenceObservation = { attribute: string; value: unknown; unit: string | null; source_id: string; note?: string };
type ReferenceEdge = { object_id: string; track: string; observations: ReferenceObservation[] };
type ReferenceStation = { platform_edges: ReferenceEdge[]; sources: { id: string; publisher: string; source_date: string; url: string }[] };

function currentValue(object: InfraObject, attribute: string) {
  const values = object.observations.filter((item) => item.attribute === attribute);
  return values.length ? String(values.at(-1)?.value ?? '') : null;
}

const equipmentLabels: Record<string, string> = { PassengerInformationEquipment: 'Fahrgastinformation', ShelterEquipment: 'Wetterschutz', StaircaseEquipment: 'Treppen', LiftEquipment: 'Aufzüge' };
const typeLabels: Record<string, string> = { stop_place: 'Bahnhof', platform: 'Bahnsteig', platform_edge: 'Bahnsteigkante', entrance: 'Zugang', equipment: 'Ausstattung' };
const attributeLabels: Record<string, string> = { name: 'Bezeichnung', equipment_type: 'Ausstattungstyp', quay_type: 'Bahnsteigtyp', public_use: 'Öffentliche Nutzung', gated: 'Zugang', lighting: 'Beleuchtung', mobility_impaired_access: 'Barrierefreiheit', safe_for_guide_dog: 'Für Blindenführhund geeignet', number_of_steps: 'Stufen', fixed: 'Fest installiert', is_external: 'Außenzugang', is_entry: 'Eingang', is_exit: 'Ausgang', latitude: 'Breitengrad', longitude: 'Längengrad', operational_state: 'Betriebszustand', wheelchair: 'Rollstuhlgerecht', tactile_paving: 'Taktile Markierung', station_number: 'Stationsnummer', uic_ref: 'OSM-UIC-Referenz' };
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
      const sourceData = await sourceResponse.json();
      setState(await stateResponse.json()); setInventory(await inventoryResponse.json()); setSources(sourceData.sources); setReference(await referenceResponse.json()); setUpdated(new Date());
    } catch { setError(true); } finally { setRefreshing(false); }
  }

  useEffect(() => { load(); }, []);
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
  const selectedObject = inventory?.objects.find((item) => item.object_key === selectedKey) ?? filteredObjects[0] ?? null;

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-[#071b2b] text-white"><div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 lg:px-10">
      <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-md bg-[#f5a623] text-[#071b2b]"><TrainFront size={22}/></span><div><p className="text-sm font-semibold tracking-wide">DB INFRASTRUKTURDATEN</p><p className="text-xs text-slate-300">Pilot Friedberg (Hess)</p></div></div>
      <button onClick={load} disabled={refreshing} className="flex min-h-11 items-center gap-2 rounded-md border border-white/20 px-4 text-sm font-medium hover:bg-white/10 disabled:opacity-60"><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''}/>Aktualisieren</button>
    </div></header>
    <div className="mx-auto max-w-[1440px] px-5 py-7 lg:px-10 lg:py-10">
      <section className="mb-7 flex flex-col justify-between gap-4 lg:flex-row lg:items-end"><div><p className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-[#b25b18]">Infrastruktur-Viewer</p><h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Friedberg (Hess)</h1><p className="mt-2 text-base text-muted-foreground">Quellenbelegter Ist-Zustand aus mehreren unabhängigen Datenquellen</p></div><div className="flex items-center gap-2 text-sm text-muted-foreground"><Database size={16}/>{updated ? `Abgerufen ${updated.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'Live-Daten werden geladen'}</div></section>
      {error ? <section className="mb-7 rounded-lg border border-red-300 bg-red-50 p-5 text-red-900"><p className="font-semibold">Datenquelle momentan nicht erreichbar</p><p className="mt-1 text-sm">Bitte in einigen Sekunden erneut aktualisieren.</p></section> : null}
      <section className="mb-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Infrastrukturobjekte" value={state?.object_count} accent="navy"/><Metric label="Bahnsteigkanten" value={state?.object_types.platform_edge} accent="orange"/><Metric label="Ausstattung" value={state?.object_types.equipment} accent="steel"/><Metric label="Aktuelle Konflikte" value={state?.conflict_count} accent="green"/></section>
      <section className="mb-7 rounded-xl border border-border bg-card shadow-sm"><div className="flex flex-col justify-between gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:px-6"><div><h2 className="text-lg font-bold">Datenquellen</h2><p className="mt-1 text-sm text-muted-foreground">Aktive Verbindungen und Qualitätsklasse</p></div><span className="text-sm font-semibold text-[#176944]">{sources.filter((source) => source.configured).length} von {sources.length || 4} verbunden</span></div><div className="source-grid">{sources.map((source) => <div className="source-row" key={source.key}><span className={`source-indicator ${source.configured ? 'source-active' : 'source-pending'}`}/><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{source.name}</p><p className="mt-1 text-xs text-muted-foreground">Qualitätsklasse {source.quality_class}</p></div><span className={source.configured ? 'source-state-active' : 'source-state-pending'}>{source.configured ? 'Aktiv' : 'Zugang fehlt'}</span></div>)}</div></section>
      <div className="grid gap-7 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.75fr)]">
        <section className="rounded-xl border border-border bg-card shadow-sm"><div className="flex items-center justify-between border-b border-border px-5 py-4 sm:px-6"><div><h2 className="text-lg font-bold">Bahnsteigübersicht</h2><p className="mt-1 text-sm text-muted-foreground">Bahnsteige und zugeordnete Gleise aus NeTEx</p></div><span className="status-ok"><ShieldCheck size={15}/>Identität geprüft</span></div><div className="space-y-3 p-4 sm:p-6">{platforms.length ? platforms.map((platform, index) => <PlatformRow key={platform.object_key} name={platform.name} edges={platform.edges} index={index + 1}/>) : [1,2,3,4,5].map((n) => <div key={n} className="h-[72px] animate-pulse rounded-lg bg-muted"/>)}</div></section>
        <div className="space-y-7"><section className="rounded-xl border border-border bg-card shadow-sm"><div className="border-b border-border px-5 py-4"><h2 className="text-lg font-bold">Ausstattung</h2><p className="mt-1 text-sm text-muted-foreground">Tatsächlich in NeTEx vorhandene Elemente</p></div><div className="divide-y divide-border px-5">{state ? Object.entries(state.equipment_types).map(([type, count]) => <div key={type} className="flex items-center justify-between py-4"><span className="text-sm font-medium">{equipmentLabels[type] ?? type}</span><strong className="tabular-nums">{count}</strong></div>) : [1,2,3].map((n) => <div key={n} className="my-3 h-8 animate-pulse rounded bg-muted"/>)}</div></section>
          <section className="rounded-xl border border-[#e9c9ad] bg-[#fff9f3] shadow-sm"><div className="flex items-center gap-2 border-b border-[#efd8c5] px-5 py-4 text-[#87420f]"><AlertTriangle size={18}/><h2 className="text-lg font-bold">Datenlücken</h2></div><div className="space-y-4 p-5">{state?.data_gaps.map((gap) => { const copy = gapLabels[gap.code] ?? { title: gap.code, text: gap.source }; return <div key={gap.code} className="flex gap-3"><MapPinOff size={17} className="mt-0.5 shrink-0 text-[#b25b18]"/><div><p className="text-sm font-semibold">{copy.title}</p><p className="mt-0.5 text-sm leading-5 text-[#73543d]">{copy.text}</p></div></div>; })}</div></section>
        </div>
      </div>
      <PlatformDataTable reference={reference}/>
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

function PlatformDataTable({ reference }: { reference: ReferenceStation | null }) {
  const value = (edge: ReferenceEdge, attribute: string) => edge.observations.find((item) => item.attribute === attribute);
  const format = (observation?: ReferenceObservation) => observation ? `${String(observation.value)}${observation.unit ? ` ${observation.unit}` : ''}` : null;
  const missing = <span className="data-missing">Nicht geliefert</span>;
  return <section className="mt-7 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
    <div className="flex flex-col justify-between gap-2 border-b border-border px-5 py-4 sm:flex-row sm:items-end sm:px-6"><div><h2 className="text-lg font-bold">Bahnsteigdaten je Gleis</h2><p className="mt-1 text-sm text-muted-foreground">Maße und Geokoordinaten mit klarer Kennzeichnung fehlender Quelldaten</p></div><span className="text-xs font-semibold text-muted-foreground">DB InfraGO · Stand 17.08.2026</span></div>
    <div className="platform-data-scroll"><table className="platform-data-table"><thead><tr><th>Gleis</th><th>Bahnsteighöhe</th><th>Baulänge</th><th>Nettobaulänge</th><th>Nutzlänge</th><th>Anfang Geokoordinaten</th><th>Ende Geokoordinaten</th></tr></thead><tbody>
      {reference?.platform_edges.map((edge) => <tr key={edge.object_id}><td><span className="track-pill">Gleis {edge.track}</span></td><td>{format(value(edge, 'platform_height')) ?? missing}</td><td>{format(value(edge, 'construction_length')) ?? missing}</td><td><strong>{format(value(edge, 'net_construction_length'))}</strong></td><td>{format(value(edge, 'usable_length')) ?? missing}</td><td>{format(value(edge, 'start_coordinates')) ?? missing}</td><td>{format(value(edge, 'end_coordinates')) ?? missing}</td></tr>)}
      {!reference ? Array.from({ length: 4 }, (_, index) => <tr key={index}><td colSpan={7}><div className="h-8 animate-pulse rounded bg-muted"/></td></tr>) : null}
    </tbody></table></div>
    <div className="platform-data-note"><AlertTriangle size={16}/><p>Die Nettobaulänge ist laut DB nicht als Zugnutzlänge geeignet. Anfangs- und Endkoordinaten werden nicht aus einem Mittelpunkt abgeleitet.</p></div>
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
    <div className="mt-5 overflow-hidden rounded-lg border border-border"><table className="evidence-table"><thead><tr><th>Attribut</th><th>Wert</th><th>Quelle</th></tr></thead><tbody>{evidence.map((entry) => <tr key={`${entry.attribute}:${entry.source_key}`}><td>{attributeLabels[entry.attribute] ?? entry.attribute.replaceAll('_', ' ')}</td><td className="font-medium">{typeof entry.value === 'boolean' ? (entry.value ? 'Ja' : 'Nein') : String(entry.value)}{entry.unit ? ` ${entry.unit}` : ''}</td><td><span className="source-chip">{{'db-infrago-openstation-netex': 'DB OpenStation', 'db-infrago-stada': 'DB StaDa', 'db-infrago-fasta': 'DB FaSta', openstreetmap: 'OpenStreetMap'}[entry.source_key] ?? entry.source_key}</span></td></tr>)}</tbody></table></div>
    <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Database size={15}/>Quellenwerte werden nicht überschrieben.</p>
  </article>;
}
