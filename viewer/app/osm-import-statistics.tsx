'use client';
import { useEffect, useState } from 'react';
type Status = { cached_stations: number; empty_stations: number; running: boolean };
export function OsmImportStatistics() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch('https://rail-infrastructure-intelligence-production.up.railway.app/sources/osm-platform-preload-status', { signal: controller.signal });
        if (!response.ok) throw new Error('status');
        const data = await response.json() as Status;
        if (!controller.signal.aborted) { setStatus(data); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { busy = false; }
    };
    void update();
    const timer = setInterval(update, 15000);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  return <section aria-label="OSM-Hintergrundimport">
    <h3>OSM-Bahnsteigdaten</h3>
    <div className="source-sync-grid">
      <div className="source-sync source-sync-available"><span><strong>Stationen geladen</strong><small>{status ? Math.max(0, Number(status.cached_stations)-Number(status.empty_stations)).toLocaleString('de-DE') : '…'}</small></span></div>
      <div className="source-sync source-sync-pending"><span><strong>Keine Daten</strong><small>{status ? Number(status.empty_stations).toLocaleString('de-DE') : '…'}</small></span></div>
    </div>
    <p>{error ? 'Statistik derzeit nicht erreichbar – letzter Stand bleibt sichtbar.' : status ? status.running ? 'Hintergrundimport läuft · Aktualisierung alle 15 Sekunden' : 'Import derzeit nicht aktiv' : 'Statistik wird geladen …'}</p>
    <small>„Keine Daten“: erfolgreich abgefragt, aber keine Bahnsteigobjekte gefunden. Fehlerhafte Abrufe sind nicht enthalten.</small>
  </section>;
}
