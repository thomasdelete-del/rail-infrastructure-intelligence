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
  isDraft?: boolean;
};

const FRIEDBERG_CENTER: [number, number] = [50.33269, 8.76126];
const API = 'https://rail-infrastructure-intelligence-production.up.railway.app';
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
export type AerialReviewAnalysis = { status: 'plausible' | 'check' | 'high' | 'insufficient_evidence'; confidence: number; reason?: string; length_conflict?: boolean; candidate_start?: { latitude: number; longitude: number }; candidate_end?: { latitude: number; longitude: number }; candidate_length_m?: number; start_shift_m?: number; end_shift_m?: number; start_confidence?: number; end_confidence?: number; start_features?: Record<string, number | boolean>; end_features?: Record<string, number | boolean>; start_learned_probability?: number | null; end_learned_probability?: number | null; training_sample_count?: number; maximum_endpoint_shift_m?: number; advisory_only: boolean };

export function StationMap({ points, focusObjectKey, coordinateEdit, aerialReviewRequest, aerialResults, onSelect, onNavigateEndpoint, onBeginCoordinateEdit, onCoordinateChange, onCancelEdit }: {
  points: StationMapPoint[];
  focusObjectKey: string | null;
  coordinateEdit: CoordinateEdit | null;
  aerialReviewRequest: { objectKey: string; nonce: number; coordinateType?: 'start' | 'end'; analysis?: AerialReviewAnalysis } | null;
  aerialResults: Record<string, AerialReviewAnalysis>;
  onSelect: (objectKey: string) => void;
  onNavigateEndpoint: (objectKey: string, analysis: AerialReviewAnalysis | undefined, coordinateType: 'start' | 'end') => void;
  onBeginCoordinateEdit: (edit: CoordinateEdit) => void;
  onCoordinateChange: (edit: CoordinateEdit, latitude: number, longitude: number) => void;
  onCancelEdit: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const reviewLayerRef = useRef<LayerGroup | null>(null);
  const satelliteLayerRef = useRef<TileLayer | null>(null);
  const aerialLayerRef = useRef<TileLayer | null>(null);
  const lastFocusedObjectRef = useRef<string | null>(null);
  const hasFitInitialBoundsRef = useRef(false);
  const previousCoordinateEditRef = useRef<CoordinateEdit | null>(null);
  const [imagery, setImagery] = useState<'none' | 'satellite' | 'official'>('none');
  const [imageryOpacity, setImageryOpacity] = useState(65);
  const [mapReady, setMapReady] = useState(false);
  const [learningMessage, setLearningMessage] = useState<string | null>(null);
  const [feedbackSelections, setFeedbackSelections] = useState<Record<string, boolean>>({});
  const reviewEndpoints = points.filter((point) => point.objectType === 'platform_edge' && (point.coordinateType === 'start' || point.coordinateType === 'end'));
  const reviewIndex = aerialReviewRequest ? reviewEndpoints.findIndex((point) => point.objectKey === aerialReviewRequest.objectKey && point.coordinateType === aerialReviewRequest.coordinateType) : -1;
  const currentReviewPoint = reviewIndex >= 0 ? reviewEndpoints[reviewIndex] : null;
  const currentTrack = currentReviewPoint?.title.replace(/^Gleis\s+/i, '') ?? '';
  const currentResult = currentTrack ? aerialResults[currentTrack] : undefined;
  const currentShift = currentReviewPoint?.coordinateType === 'start' ? currentResult?.start_shift_m : currentResult?.end_shift_m;
  const currentConfidence = currentReviewPoint?.coordinateType === 'start' ? currentResult?.start_confidence : currentResult?.end_confidence;
  const feedbackKey = currentReviewPoint ? `${currentReviewPoint.objectKey}:${currentReviewPoint.coordinateType}` : '';
  const currentFeedback = feedbackKey ? feedbackSelections[feedbackKey] : undefined;
  const correctEndpointWasSet = Boolean(currentReviewPoint?.isDraft);
  const navigateReview = (direction: -1 | 1) => {
    if (!reviewEndpoints.length) return;
    const nextIndex = (Math.max(reviewIndex, 0) + direction + reviewEndpoints.length) % reviewEndpoints.length;
    const next = reviewEndpoints[nextIndex];
    const track = next.title.replace(/^Gleis\s+/i, '');
    onNavigateEndpoint(next.objectKey, aerialResults[track], next.coordinateType as 'start' | 'end');
  };
  const submitTrainingFeedback = async (accepted: boolean) => {
    if (!currentReviewPoint || !currentResult) return;
    const endpoint = currentReviewPoint.coordinateType as 'start' | 'end';
    const features = endpoint === 'start' ? currentResult.start_features : currentResult.end_features;
    if (!features) { setLearningMessage('Kein lernbarer Kandidat vorhanden'); return; }
    setLearningMessage('Bewertung wird gespeichert …');
    try {
      const response = await fetch(`${API}/stations/friedberg-hess/aerial-analysis/training-feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: currentTrack, endpoint, accepted, features,
          confirmed_coordinate: accepted ? { latitude: currentReviewPoint.latitude, longitude: currentReviewPoint.longitude } : null }),
      });
      if (!response.ok) throw new Error();
      setFeedbackSelections((current) => {
        const next = { ...current, [feedbackKey]: accepted };
        localStorage.setItem('friedberg-endpoint-feedback', JSON.stringify(next));
        return next;
      });
      setLearningMessage(accepted ? 'Als echter Abschluss gelernt' : 'Als Fehlkandidat gelernt');
    } catch { setLearningMessage('Bewertung konnte nicht gespeichert werden'); }
  };

  useEffect(() => {
    try { setFeedbackSelections(JSON.parse(localStorage.getItem('friedberg-endpoint-feedback') ?? '{}') as Record<string, boolean>); }
    catch { setFeedbackSelections({}); }
  }, []);

  useEffect(() => {
    if (previousCoordinateEditRef.current && !coordinateEdit && correctEndpointWasSet) {
      setLearningMessage('Richtiger Abschluss gesetzt');
    }
    previousCoordinateEditRef.current = coordinateEdit;
  }, [coordinateEdit, correctEndpointWasSet]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !containerRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: true, doubleClickZoom: false, minZoom: 14, maxZoom: 24 }).setView(FRIEDBERG_CENTER, 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxNativeZoom: 19,
        maxZoom: 24,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-Mitwirkende</a>',
      }).addTo(map);
      const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxNativeZoom: 19,
        maxZoom: 24,
        opacity: 0,
        attribution: 'Satellitenbild &copy; Esri, Maxar, Earthstar Geographics und weitere',
      }).addTo(map);
      const aerial = L.tileLayer.wms(HESSEN_DOP_WMS, {
        layers: 'he_dop20_rgb',
        format: 'image/png',
        transparent: true,
        version: '1.1.1',
        maxZoom: 24,
        opacity: 0,
        attribution: 'Luftbild: &copy; Hessische Verwaltung f&uuml;r Bodenmanagement und Geoinformation · DL-DE Zero-2.0',
      }).addTo(map);
      const markerLayer = L.layerGroup().addTo(map);
      const reviewLayer = L.layerGroup().addTo(map);
      mapRef.current = map;
      markerLayerRef.current = markerLayer;
      reviewLayerRef.current = reviewLayer;
      satelliteLayerRef.current = satellite;
      aerialLayerRef.current = aerial;
      setMapReady(true);
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      reviewLayerRef.current = null;
      satelliteLayerRef.current = null;
      aerialLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    satelliteLayerRef.current?.setOpacity(imagery === 'satellite' ? imageryOpacity / 100 : 0);
    aerialLayerRef.current?.setOpacity(imagery === 'official' ? imageryOpacity / 100 : 0);
  }, [imagery, imageryOpacity, mapReady]);

  useEffect(() => {
    if (aerialReviewRequest) {
      setImagery('official');
      setImageryOpacity(100);
    }
  }, [aerialReviewRequest]);

  useEffect(() => {
    if (!mapReady || !markerLayerRef.current) return;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled || !markerLayerRef.current) return;
      markerLayerRef.current.clearLayers();
      points.forEach((point) => {
        const endpoint = point.coordinateType !== 'position';
        const focused = point.objectKey === focusObjectKey;
        const draftSize = focused ? 24 : 14;
        const marker = point.isDraft ? L.marker([point.latitude, point.longitude], {
          icon: L.divIcon({ className: `coordinate-draft-marker coordinate-draft-${point.coordinateType}${focused ? ' coordinate-draft-focused' : ''}`, html: '<span></span>', iconSize: [draftSize, draftSize], iconAnchor: [draftSize / 2, draftSize / 2] }),
        }) : L.circleMarker([point.latitude, point.longitude], {
          radius: point.isDraft ? 8 : focused ? 10 : endpoint ? 5 : point.objectType === 'stop_place' ? 9 : 6,
          color: point.isDraft ? '#7c2d92' : focused ? '#f5a623' : '#ffffff',
          weight: point.isDraft || focused ? 4 : 2,
          fillColor: point.isDraft ? '#f5a623' : point.objectType === 'platform_edge' ? platformCoordinateColors[point.coordinateType] : markerColors[point.objectType] ?? '#445b66',
          fillOpacity: 0.96,
        });
        const endpointReview = aerialReviewRequest?.objectKey === point.objectKey && Boolean(aerialReviewRequest.coordinateType);
        marker.bindTooltip(escapeHtml(point.title), { direction: 'top', offset: [0, -7], permanent: focused && !endpointReview, className: focused && !endpointReview ? 'focused-platform-label' : '' });
        const coordinateLabel = point.objectType === 'platform_edge' && point.coordinateType === 'position' ? 'Gleiskoordinate' : coordinateLabels[point.coordinateType];
        marker.bindPopup(`<strong>${escapeHtml(point.title)}</strong><br>${escapeHtml(typeLabels[point.objectType] ?? point.objectType)} · ${coordinateLabel}${point.isDraft ? ' · Aktualisiert' : ''}<br><small>${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}<br>${point.isDraft ? 'Manueller Prüfvorschlag' : 'Quelle: OpenStreetMap'}</small>`);
        marker.on('click', () => onSelect(point.objectKey));
        if (point.objectType === 'platform_edge' && point.coordinateType !== 'position') {
          const coordinateType = point.coordinateType;
          marker.on('dblclick', () => {
            marker.closePopup();
            mapRef.current?.closePopup();
            onSelect(point.objectKey);
            onBeginCoordinateEdit({ objectKey: point.objectKey, coordinateType, title: point.title });
          });
        }
        marker.addTo(markerLayerRef.current!);
      });
      if (points.length && mapRef.current && !hasFitInitialBoundsRef.current) {
        hasFitInitialBoundsRef.current = true;
        const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number]));
        mapRef.current.fitBounds(bounds.pad(0.12), { maxZoom: 18, animate: false });
      }
    });
    return () => { cancelled = true; };
  }, [aerialReviewRequest, focusObjectKey, mapReady, onBeginCoordinateEdit, onSelect, points]);

  useEffect(() => {
    if (!focusObjectKey) { lastFocusedObjectRef.current = null; return; }
    if (!mapReady || !mapRef.current || lastFocusedObjectRef.current === focusObjectKey) return;
    lastFocusedObjectRef.current = focusObjectKey;
    const objectPoints = points.filter((point) => point.objectKey === focusObjectKey);
    if (!objectPoints.length) return;
    void import('leaflet').then((L) => {
      if (!mapRef.current) return;
      const bounds = L.latLngBounds(objectPoints.map((point) => [point.latitude, point.longitude] as [number, number]));
      mapRef.current.fitBounds(bounds.pad(0.45), { maxZoom: 24, animate: true });
    });
  }, [focusObjectKey, mapReady, points]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !reviewLayerRef.current) return;
    const layer = reviewLayerRef.current;
    layer.clearLayers();
    if (!aerialReviewRequest) return;
    const original = points.filter((point) => point.objectKey === aerialReviewRequest.objectKey && (point.coordinateType === 'start' || point.coordinateType === 'end'));
    const analysis = aerialReviewRequest.analysis;
    if (original.length < 2) return;
    void import('leaflet').then((L) => {
      if (!mapRef.current || !reviewLayerRef.current) return;
      const startPoint = original.find((point) => point.coordinateType === 'start')!;
      const endPoint = original.find((point) => point.coordinateType === 'end')!;
      const osmCoordinates: [number, number][] = [[startPoint.latitude, startPoint.longitude], [endPoint.latitude, endPoint.longitude]];
      const proposed: Array<[number, number] | null> = [analysis?.candidate_start ? [analysis.candidate_start.latitude, analysis.candidate_start.longitude] : null, analysis?.candidate_end ? [analysis.candidate_end.latitude, analysis.candidate_end.longitude] : null];
      if (aerialReviewRequest.coordinateType) {
        const endpointIndex = aerialReviewRequest.coordinateType === 'start' ? 0 : 1;
        if (proposed[0] && proposed[1]) {
          L.polyline([proposed[0], proposed[1]], { color: '#00a6c7', weight: 6, opacity: .9 }).addTo(reviewLayerRef.current);
          proposed.forEach((coordinate, index) => {
            if (!coordinate) return;
            L.circleMarker(coordinate, { radius: index === endpointIndex ? 10 : 7, color: '#fff', weight: 3, fillColor: '#00a6c7', fillOpacity: 1 }).addTo(reviewLayerRef.current!);
          });
        }
        L.circleMarker(osmCoordinates[endpointIndex], { radius: 7, color: '#f59e0b', weight: 3, fillColor: '#fff', fillOpacity: .2, dashArray: '3 3' }).addTo(reviewLayerRef.current);
        const target = proposed[endpointIndex] ?? osmCoordinates[endpointIndex];
        mapRef.current.setView(target, 21, { animate: false });
        return;
      }
      L.polyline(osmCoordinates, { color: '#f59e0b', weight: 5, opacity: .95, dashArray: '10 7' }).bindTooltip('OSM-Bahnsteigkante', { permanent: true, direction: 'center', className: 'map-review-label map-review-osm' }).addTo(reviewLayerRef.current);
      const allCoordinates = [...osmCoordinates];
      if (proposed[0] && proposed[1]) {
        L.polyline([proposed[0], proposed[1]], { color: '#00a6c7', weight: 6, opacity: .95 }).bindTooltip(`Luftbild-Vorschlag${analysis?.candidate_length_m ? ` · ${analysis.candidate_length_m.toFixed(1)} m` : ''}`, { permanent: true, direction: 'center', className: 'map-review-label map-review-proposal' }).addTo(reviewLayerRef.current);
      }
      proposed.forEach((coordinate, index) => {
        if (coordinate) {
          const shift = mapRef.current!.distance(osmCoordinates[index], coordinate);
          const confirmed = shift <= 3;
          L.polyline([osmCoordinates[index], coordinate], { color: confirmed ? '#20845a' : '#d32f2f', weight: 3, opacity: .95, dashArray: '4 5' }).bindTooltip(confirmed ? 'OSM im Luftbild bestätigt' : `Abweichung ${shift.toFixed(1)} m`, { permanent: true, direction: 'center', className: `map-review-label ${confirmed ? 'map-review-confirmed' : 'map-review-deviation'}` }).addTo(reviewLayerRef.current!);
          L.circleMarker(coordinate, { radius: 7, color: '#fff', weight: 2, fillColor: '#00a6c7', fillOpacity: 1 }).addTo(reviewLayerRef.current!);
          allCoordinates.push(coordinate);
        }
      });
      mapRef.current.fitBounds(L.latLngBounds(allCoordinates).pad(.35), { maxZoom: 23, animate: true });
    });
  }, [aerialReviewRequest, mapReady, points]);

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
      <div><p className="map-kicker"><LocateFixed size={15}/>Karteneinstieg</p><h2>Bahnhof Friedberg im Lageplan</h2><p>OSM-Koordinaten werden zuerst mit dem amtlichen Hessen-DOP geprüft; das allgemeine Satellitenbild bleibt als zweite Ansicht verfügbar.</p></div>
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
      {currentReviewPoint ? <div className="endpoint-review-nav"><button type="button" onClick={() => navigateReview(-1)} aria-label="Vorherigen Endpunkt prüfen">‹</button><div><strong>{currentReviewPoint.title} · {currentReviewPoint.coordinateType === 'start' ? 'Anfang' : 'Ende'}</strong><span>{currentResult?.length_conflict ? 'Nicht bestätigt · Längenkonflikt' : currentShift === undefined ? 'Nicht eindeutig bestätigt' : Math.abs(currentShift) <= 3 ? `OSM-Kandidat · ${Math.round((currentConfidence ?? 0) * 100)}%` : `Abweichung ${currentShift >= 0 ? '+' : ''}${currentShift.toFixed(1)} m · ${Math.round((currentConfidence ?? 0) * 100)}%`}</span><small>{currentResult?.training_sample_count ? `Lernmodell: ${currentResult.training_sample_count} Bewertungen` : 'Lernmodell: Lernphase'}</small><div className="endpoint-learning-actions"><button type="button" className={currentFeedback === true ? 'learning-correct-active' : ''} aria-pressed={currentFeedback === true} onClick={() => void submitTrainingFeedback(true)}>Abschluss korrekt</button><button type="button" className={currentFeedback === false ? 'learning-wrong-active' : ''} aria-pressed={currentFeedback === false} onClick={() => { void submitTrainingFeedback(false); onBeginCoordinateEdit({ objectKey: currentReviewPoint.objectKey, coordinateType: currentReviewPoint.coordinateType as 'start' | 'end', title: currentReviewPoint.title }); }}>Kein Abschluss</button><button type="button" className={correctEndpointWasSet ? 'learning-corrected-active' : ''} aria-pressed={correctEndpointWasSet} onClick={() => onBeginCoordinateEdit({ objectKey: currentReviewPoint.objectKey, coordinateType: currentReviewPoint.coordinateType as 'start' | 'end', title: currentReviewPoint.title })}>{correctEndpointWasSet ? 'Richtiger Abschluss gesetzt' : 'Richtigen Abschluss setzen'}</button></div>{learningMessage ? <small>{learningMessage}</small> : null}</div><button type="button" onClick={() => navigateReview(1)} aria-label="Nächsten Endpunkt prüfen">›</button></div> : null}
      <div className="map-legend"><span><i className="legend-station"/>Bahnhof</span><span><i className="legend-platform"/>Bahnsteig</span><span><i className="legend-track-coordinate"/>Gleiskoordinate</span><span><i className="legend-platform-start"/>Bahnsteiganfang</span><span><i className="legend-platform-end"/>Bahnsteigende</span><span><i className="legend-coordinate-draft"/>Aktualisierter Punkt</span><span><i className="legend-entrance"/>Zugang</span><span><i className="legend-equipment"/>Ausstattung</span><span className="legend-source"><Layers3 size={14}/>OSM-Punkte</span></div>
    </div>
  </section>;
}
