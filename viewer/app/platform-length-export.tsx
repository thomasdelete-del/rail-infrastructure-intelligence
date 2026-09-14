'use client';
import { useState } from 'react';
const API = 'https://rail-infrastructure-intelligence-production.up.railway.app';

export function PlatformLengthExport() {
  const [filters, setFilters] = useState({ station:'', ril:'', track:'', source:'all', minimum:'', maximum:'' });
  const invalid = filters.minimum !== '' && filters.maximum !== '' && Number(filters.minimum)>Number(filters.maximum);
  const params = new URLSearchParams(Object.entries(filters).filter(([,value]) => value !== ''));
  return <section className="platform-export" aria-label="Bahnsteiglängen exportieren">
    <h3>Bahnsteiglängen · CSV-Export aller Stationen</h3>
    <p>Leere Filter exportieren den gesamten gespeicherten Bestand. Je Quelle eine Zeile; fehlende Längen werden nicht ersetzt.</p>
    <div className="platform-export-filters">
      {([['station','Station enthält'],['ril','RIL100'],['track','Gleis exakt'],['minimum','Mindestens (m)'],['maximum','Höchstens (m)']] as const).map(([key,label]) =>
        <label key={key}>{label}<input type={key==='minimum'||key==='maximum'?'number':'text'} min={key==='minimum'||key==='maximum'?0:undefined} step="any" value={filters[key]} onChange={event => setFilters({...filters,[key]:event.target.value})} /></label>)}
      <label>Quelle<select value={filters.source} onChange={event => setFilters({...filters,source:event.target.value})}>
        <option value="all">Alle Quellen</option><option value="isr">DB ISR · Nutzlänge</option><option value="db">DB InfraGO · Nettobaulänge</option><option value="osm">OSM · Original-Linienlänge</option>
      </select></label>
    </div>
    {invalid ? <p role="alert">Das Minimum darf nicht größer als das Maximum sein.</p> : <a className="map-toggle map-toggle-active" href={`${API}/exports/platform-lengths.csv?${params}`}>CSV herunterladen</a>}
    <button className="map-toggle" type="button" onClick={() => setFilters({station:'',ril:'',track:'',source:'all',minimum:'',maximum:''})}>Filter zurücksetzen</button>
    <small>CSV: UTF-8, Semikolon, Dezimalkomma. OSM: gespeicherte Originalgeometrie ohne manuelle Endpunktkorrekturen; Flächen und nicht gespeicherte Daten sind nicht enthalten.</small>
  </section>;
}
