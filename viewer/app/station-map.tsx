'use client';

import { Layers3, LocateFixed, Satellite } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { LayerGroup, Map as LeafletMap, TileLayer } from 'leaflet';

export type StationMapPoint = {
  id: string;
  objectKey: string;
  latitude: number;
  longitude: number;
  title: string;
  objectType: string;
  coordinateType: 'position' | 'start' | 'end';
};

const FRIEDBERG_CENTER: [number, number] = [50.33269, 8.76126];
const markerColors: Record<string, string> = {
  stop_place: '#d54532',
  platform: '#0b5278',
  platform_edge: '#e08a14',
  entrance: '#20845a',
  equipment: '#7564a5',
};
const typeLabels: Record<string, string> = {
  stop_place: 'Bahnhof',
  platform: 'Bahnsteig',
  platform_edge: 'Bahnsteigkante',
  entrance: 'Zugang',
  equipment: 'Ausstattung',
};
const coordinateLabels = { position: 'OSM-Position', start: 'Bahnsteiganfang', end: 'Bahnsteigende' };

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function StationMap({ points, onSelect }: { points: StationMapPoint[]; onSelect: (objectKey: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const satelliteLayerRef = useRef<TileLayer | null>(null);
  const [satelliteVisible, setSatelliteVisible] = useState(false);
  const [satelliteOpacity, setSatelliteOpacity] = useState(65);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: true, minZoom: 14, maxZoom: 19 }).setView(FRIEDBERG_CENTER, 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>',
      }).addTo(map);
      const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        opacity: 0,
        attribution: 'Satellitenbild &copy; Esri, Maxar, Earthstar Geographics und weitere',
      }).addTo(map);
      const markerLayer = L.layerGroup().addTo(map);
      mapRef.current = map;
      markerLayerRef.current = markerLayer;
      satelliteLayerRef.current = satellite;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      satelliteLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    satelliteLayerRef.current?.setOpacity(satelliteVisible ? satelliteOpacity / 100 : 0);
  }, [satelliteVisible, satelliteOpacity, mapReady]);

  useEffect(() => {
    if (!mapReady || !markerLayerRef.current) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !markerLayerRef.current) return;
      markerLayerRef.current.clearLayers();
      points.forEach((point) => {
        const endpoint = point.coordinateType !== 'position';
        const marker = L.circleMarker([point.latitude, point.longitude], {
          radius: endpoint ? 5 : point.objectType === 'stop_place' ? 9 : 6,
          color: '#ffffff',
          weight: 2,
          fillColor: markerColors[point.objectType] ?? '#445b66',
          fillOpacity: 0.96,
        });
        marker.bindTooltip(escapeHtml(point.title), { direction: 'top', offset: [0, -5] });
        marker.bindPopup(`<strong>${escapeHtml(point.title)}</strong><br>${escapeHtml(typeLabels[point.objectType] ?? point.objectType)} · ${coordinateLabels[point.coordinateType]}<br><small>${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}<br>Quelle: OpenStreetMap</small>`);
        marker.on('click', () => onSelect(point.objectKey));
        marker.addTo(markerLayerRef.current!);
      });
      if (points.length && mapRef.current) {
        const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number]));
        mapRef.current.fitBounds(bounds.pad(0.12), { maxZoom: 18, animate: false });
      }
    });
    return () => { cancelled = true; };
  }, [mapReady, onSelect, points]);

  function resetView() {
    mapRef.current?.setView(FRIEDBERG_CENTER, 17);
  }

  return <section className="station-map-card">
    <div className="station-map-heading">
      <div><p className="map-kicker"><LocateFixed size={15}/>Karteneinstieg</p><h2>Bahnhof Friedberg im Lageplan</h2><p>Alle Marker stammen aus gespeicherten OpenStreetMap-Koordinaten. Anklicken für Quelle und Objektbezug.</p></div>
      <div className="map-summary"><strong>{points.length || '–'}</strong><span>verortete Messpunkte</span></div>
    </div>
    <div className="station-map-wrap">
      <div ref={containerRef} className="station-map" aria-label="Interaktive Karte des Bahnhofs Friedberg mit OpenStreetMap-Messpunkten"/>
      {!mapReady ? <div className="map-loading">Karte wird geladen …</div> : null}
      <div className="map-controls" aria-label="Kartenebenen">
        <button type="button" className={satelliteVisible ? 'map-toggle map-toggle-active' : 'map-toggle'} aria-pressed={satelliteVisible} onClick={() => setSatelliteVisible((visible) => !visible)}><Satellite size={17}/><span>Satellit</span></button>
        {satelliteVisible ? <label className="opacity-control"><span>Deckkraft</span><input type="range" min="20" max="100" step="5" value={satelliteOpacity} onChange={(event) => setSatelliteOpacity(Number(event.target.value))}/><strong>{satelliteOpacity}%</strong></label> : null}
        <button type="button" className="map-icon-button" aria-label="Bahnhof zentrieren" title="Bahnhof zentrieren" onClick={resetView}><LocateFixed size={18}/></button>
      </div>
      <div className="map-legend"><span><i className="legend-station"/>Bahnhof</span><span><i className="legend-platform"/>Bahnsteig</span><span><i className="legend-edge"/>Bahnsteigkante</span><span><i className="legend-entrance"/>Zugang</span><span><i className="legend-equipment"/>Ausstattung</span><span className="legend-source"><Layers3 size={14}/>OSM-Punkte</span></div>
    </div>
  </section>;
}
