'use client';

import { Crosshair, ExternalLink, Layers3, LocateFixed, Satellite, X } from 'lucide-react';
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
const HESSEN_DOP_WMS = 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows';
const HESSEN_GEODATENVIEWER = 'https://www.geoportal.hessen.de/map?LAYER%5Bzoom%5D=1&LAYER%5Bid%5D=52119&LAYER%5Bvisible%5D=1&LAYER%5Bquerylayer%5D=1';
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
const platformCoordinateColors = { position: '#1873a5', start: '#20a464', end: '#d54532' };

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export type CoordinateEdit = { objectKey: string; coordinateType: 'start' | 'end'; title: string };

export function StationMap({ points, focusObjectKey, coordinateEdit, onSelect, onBeginCoordinateEdit, onCoordinateChange, onCancelEdit }: {
  points: StationMapPoint[];
  focusObjectKey: string | null;
  coordinateEdit: CoordinateEdit | null;
  onSelect: (objectKey: string) => void;
  onBeginCoordinateEdit: (edit: CoordinateEdit) => void;
  onCoordinateChange: (edit: CoordinateEdit, latitude: number, longitude: number) => void;
  onCancelEdit: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const satelliteLayerRef = useRef<TileLayer | null>(null);
  const aerialLayerRef = useRef<TileLayer | null>(null);
  const [imagery, setImagery] = useState<'none' | 'satellite' | 'official'>('none');
  const [imageryOpacity, setImageryOpacity] = useState(65);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: true, minZoom: 14, maxZoom: 22 }).setView(FRIEDBERG_CENTER, 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19,
        maxZoom: 22,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>',
      }).addTo(map);
      const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 19,
        maxZoom: 22,
        opacity: 0,
        attribution: 'Satellitenbild &copy; Esri, Maxar, Earthstar Geographics und weitere',
      }).addTo(map);
      const aerial = L.tileLayer.wms(HESSEN_DOP_WMS, {
        layers: 'he_dop20_rgb',
        format: 'image/png',
        transparent: true,
        version: '1.1.1',
        maxZoom: 22,
        opacity: 0,
        attribution: 'Luftbild: &copy; Hessische Verwaltung f&uuml;r Bodenmanagement und Geoinformation · DL-DE Zero-2.0',
      }).addTo(map);
      const markerLayer = L.layerGroup().addTo(map);
      mapRef.current = map;
      markerLayerRef.current = markerLayer;
      satelliteLayerRef.current = satellite;
      aerialLayerRef.current = aerial;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      satelliteLayerRef.current = null;
      aerialLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    satelliteLayerRef.current?.setOpacity(imagery === 'satellite' ? imageryOpacity / 100 : 0);
    aerialLayerRef.current?.setOpacity(imagery === 'official' ? imageryOpacity / 100 : 0);
  }, [imagery, imageryOpacity, mapReady]);

  useEffect(() => {
    if (!mapReady || !markerLayerRef.current) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !markerLayerRef.current) return;
      markerLayerRef.current.clearLayers();
      points.forEach((point) => {
        const endpoint = point.coordinateType !== 'position';
        const focused = point.objectKey === focusObjectKey;
        const marker = L.circleMarker([point.latitude, point.longitude], {
          radius: focused ? 10 : endpoint ? 5 : point.objectType === 'stop_place' ? 9 : 6,
          color: focused ? '#f5a623' : '#ffffff',
          weight: focused ? 4 : 2,
          fillColor: point.objectType === 'platform_edge' ? platformCoordinateColors[point.coordinateType] : markerColors[point.objectType] ?? '#445b66',
          fillOpacity: 0.96,
        });
        marker.bindTooltip(escapeHtml(point.title), { direction: 'top', offset: [0, -7], permanent: focused, className: focused ? 'focused-platform-label' : '' });
        const coordinateLabel = point.objectType === 'platform_edge' && point.coordinateType === 'position' ? 'Gleiskoordinate' : coordinateLabels[point.coordinateType];
        marker.bindPopup(`<strong>${escapeHtml(point.title)}</strong><br>${escapeHtml(typeLabels[point.objectType] ?? point.objectType)} · ${coordinateLabel}<br><small>${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}<br>Quelle: OpenStreetMap</small>`);
        marker.on('click', () => onSelect(point.objectKey));
        if (point.objectType === 'platform_edge' && point.coordinateType !== 'position') {
          const coordinateType = point.coordinateType;
          marker.on('dblclick', () => {
            onSelect(point.objectKey);
            onBeginCoordinateEdit({ objectKey: point.objectKey, coordinateType, title: point.title });
          });
        }
        marker.addTo(markerLayerRef.current!);
      });
      if (points.length && mapRef.current) {
        const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number]));
        mapRef.current.fitBounds(bounds.pad(0.12), { maxZoom: 18, animate: false });
      }
    });
    return () => { cancelled = true; };
  }, [focusObjectKey, mapReady, onBeginCoordinateEdit, onSelect, points]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !focusObjectKey) return;
    const objectPoints = points.filter((point) => point.objectKey === focusObjectKey);
    if (!objectPoints.length) return;
    void import('leaflet').then((L) => {
      if (!mapRef.current) return;
      const bounds = L.latLngBounds(objectPoints.map((point) => [point.latitude, point.longitude] as [number, number]));
      mapRef.current.fitBounds(bounds.pad(0.45), { maxZoom: 22, animate: true });
    });
  }, [focusObjectKey, mapReady, points]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !coordinateEdit) return;
    map.getContainer().style.cursor = 'crosshair';
    const handleClick = (event: { latlng: { lat: number; lng: number } }) => onCoordinateChange(coordinateEdit, event.latlng.lat, event.latlng.lng);
    map.once('click', handleClick);
    return () => {
      map.off('click', handleClick);
      map.getContainer().style.cursor = '';
    };
  }, [coordinateEdit, onCoordinateChange]);

  function resetView() {
    mapRef.current?.setView(FRIEDBERG_CENTER, 17);
  }

  return <section id="station-map" className="station-map-card">
    <div className="station-map-heading">
      <div><p className="map-kicker"><LocateFixed size={15}/>Karteneinstieg</p><h2>Bahnhof Friedberg im Lageplan</h2><p>OSM-Koordinaten auf Satellitenbild prüfen; das amtliche Hessen-DOP ist als zusätzliche Ebene verfügbar.</p></div>
      <div className="map-heading-actions"><a className="geodata-link" href={HESSEN_GEODATENVIEWER} target="_blank" rel="noreferrer">Geodatenviewer Hessen <ExternalLink size={14}/></a><div className="map-summary"><strong>{points.length || '–'}</strong><span>verortete Messpunkte</span></div></div>
    </div>
    <div className="station-map-wrap">
      <div ref={containerRef} className="station-map" aria-label="Interaktive Karte des Bahnhofs Friedberg mit OpenStreetMap-Messpunkten"/>
      {!mapReady ? <div className="map-loading">Karte wird geladen …</div> : null}
      <div className="map-controls" aria-label="Kartenebenen">
        <button type="button" className={imagery === 'satellite' ? 'map-toggle map-toggle-active' : 'map-toggle'} aria-pressed={imagery === 'satellite'} onClick={() => setImagery((current) => current === 'satellite' ? 'none' : 'satellite')}><Satellite size={17}/><span>Satellit</span></button>
        <button type="button" className={imagery === 'official' ? 'map-toggle map-toggle-active' : 'map-toggle'} aria-pressed={imagery === 'official'} onClick={() => setImagery((current) => current === 'official' ? 'none' : 'official')}><Layers3 size={17}/><span>Amtliches Luftbild</span></button>
        {imagery !== 'none' ? <label className="opacity-control"><span>Deckkraft</span><input type="range" min="20" max="100" step="5" value={imageryOpacity} onChange={(event) => setImageryOpacity(Number(event.target.value))}/><strong>{imageryOpacity}%</strong></label> : null}
        <button type="button" className="map-icon-button" aria-label="Bahnhof zentrieren" title="Bahnhof zentrieren" onClick={resetView}><LocateFixed size={18}/></button>
      </div>
      {coordinateEdit ? <div className="coordinate-edit-banner"><Crosshair size={18}/><span><strong>{coordinateEdit.title}</strong>: neuen {coordinateEdit.coordinateType === 'start' ? 'Anfang' : 'Endpunkt'} in der Karte anklicken</span><button type="button" onClick={onCancelEdit} aria-label="Koordinatenänderung abbrechen"><X size={17}/></button></div> : null}
      <div className="map-legend"><span><i className="legend-station"/>Bahnhof</span><span><i className="legend-platform"/>Bahnsteig</span><span><i className="legend-track-coordinate"/>Gleiskoordinate</span><span><i className="legend-platform-start"/>Bahnsteiganfang</span><span><i className="legend-platform-end"/>Bahnsteigende</span><span><i className="legend-entrance"/>Zugang</span><span><i className="legend-equipment"/>Ausstattung</span><span className="legend-source"><Layers3 size={14}/>OSM-Punkte</span></div>
    </div>
  </section>;
}
