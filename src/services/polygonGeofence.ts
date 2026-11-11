import { DEPOT, MAX_DEST, MAX_VOL } from '../config/constants';
import { PhysicalDestination } from '../types';
import { esc, S, toast } from '../state/store';
import { active, alternatives, avgDistToCluster, clusterStrictZones, deduplicateFleetStops, isReturnDepot, vol } from './routing';
import { syncAllRoutesRealDistance } from './osrm';
import { classifyZone, hav } from '../config/zones';
import { draw, drawAllRoutes } from '../map/leafletMap';
import { renderRoutes } from '../ui/routeCards';
import { withJamarLoader } from '../ui/loader';
import { publishRoutesToTelemetryServer } from './telemetry';

declare const L: any;

export interface PolygonItem {
  id: string;
  name: string;
  color: string;
  vertices: [number, number][];
}

export const polygonState = {
  isDrawing: false,
  currentVertices: [] as [number, number][],
  polygons: [] as PolygonItem[],
  selectedPolyId: null as string | null
};

// Capas Leaflet dedicadas
let tempPolygonLayer: any = null;
let tempMarkersLayer: any = null;
let savedPolygonsLayer: any = null;
let unassignedPinsLayer: any = null;

// Control de arrastre de vértices en tiempo real
let isDraggingVertex = false;
let lastVertexDragEndTime = 0;

/* =========================================================================
   A. BLINDAJE DE RUTAS FIJADAS (lockedByLasso) Y RAY-CASTING
   ========================================================================= */

export function getLockedLassoStopIds(): Set<number> {
  const lockedIds = new Set<number>();
  (S.routes || []).forEach(r => {
    if (r.lockedByLasso) {
      active(r).forEach((s: any) => {
        if (s && s.id !== undefined) {
          lockedIds.add(s.id);
        }
      });
    }
  });
  return lockedIds;
}

export function isPointInPolygon(lat: number, lng: number, vertices: [number, number][]): boolean {
  if (!vertices || vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i][0];
    const yi = vertices[i][1];
    const xj = vertices[j][0];
    const yj = vertices[j][1];

    const intersect = yi > lng !== yj > lng && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function getDestinationsInsidePolygon(
  vertices: [number, number][],
  omitLockedLassoStops = true
): PhysicalDestination[] {
  if (!vertices || vertices.length < 3 || !S.destinations) return [];
  const lockedIds = omitLockedLassoStops ? getLockedLassoStopIds() : new Set<number>();

  return S.destinations.filter(d => {
    if (!d.lat || !d.lng) return false;
    if (omitLockedLassoStops && lockedIds.has(d.id)) return false;
    return isPointInPolygon(d.lat, d.lng, vertices);
  });
}

/**
 * Agrupa las paradas encerradas en el polígono.
 * Si las paradas caben en un camión Jamar (hasta 15 paradas y hasta 18 m³),
 * se respeta fielmente la selección del usuario creando 1 SOLA RUTA UNIFICADA.
 * Si supera 15 paradas o 18 m³, se agrupan por cercanía respetando los topes duros máximos.
 */
export function groupPolygonStops(stops: PhysicalDestination[]): PhysicalDestination[][] {
  if (!stops || !stops.length) return [];
  const totalVol = vol(stops);

  // Si cabe completo en un camión Jamar, 1 sola ruta exacta
  if (stops.length <= MAX_DEST && totalVol <= MAX_VOL) {
    return [stops];
  }

  // Si excede 15 paradas o 18 m³, particionar por proximidad con tope duro MAX_DEST (15) y MAX_VOL (18)
  const unassigned = [...stops];
  const clusters: PhysicalDestination[][] = [];

  while (unassigned.length) {
    unassigned.sort((a, b) => hav(DEPOT.lat, DEPOT.lng, b.lat!, b.lng!) - hav(DEPOT.lat, DEPOT.lng, a.lat!, a.lng!));
    const seed = unassigned.shift()!;
    const cluster = [seed];

    let found = true;
    while (found && cluster.length < MAX_DEST && vol(cluster) < MAX_VOL) {
      found = false;
      const cLat = cluster.reduce((sum, x) => sum + x.lat!, 0) / cluster.length;
      const cLng = cluster.reduce((sum, x) => sum + x.lng!, 0) / cluster.length;

      let bestIdx = -1;
      let bestScore = Infinity;

      for (let i = 0; i < unassigned.length; i++) {
        const cand = unassigned[i];
        if (vol(cluster) + cand.vol > MAX_VOL) continue;
        if (cluster.length + 1 > MAX_DEST) continue;

        const d = hav(cLat, cLng, cand.lat!, cand.lng!);
        if (d < bestScore) {
          bestScore = d;
          bestIdx = i;
        }
      }

      if (bestIdx !== -1) {
        cluster.push(unassigned.splice(bestIdx, 1)[0]);
        found = true;
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

export function toggleRouteLassoLock(routeId: number, ev?: Event): void {
  if (ev) {
    ev.stopPropagation();
    ev.preventDefault();
  }
  const r = (S.routes || []).find(x => x.id === routeId);
  if (!r) return;
  r.lockedByLasso = !r.lockedByLasso;
  renderRoutes();
  renderPolygonToolbarUI();
  toast(
    r.lockedByLasso
      ? `🔒 Ruta ${r.id + 1} blindada. Sus puntos se omitirán en nuevos lazos.`
      : `🔓 Ruta ${r.id + 1} liberada. Sus puntos ahora pueden re-zonificarse.`,
    'info'
  );
}

export function unlockAllLassoRoutes(): void {
  let count = 0;
  (S.routes || []).forEach(r => {
    if (r.lockedByLasso) {
      r.lockedByLasso = false;
      count++;
    }
  });
  renderRoutes();
  renderPolygonToolbarUI();
  if (count > 0) {
    toast(`🔓 Se liberó el blindaje de ${count} ruta(s).`, 'info');
  }
}

/* =========================================================================
   B. TRAZADO DEL LAZO CON VÉRTICES ARRASTRABLES Y BOTÓN DESHACER
   ========================================================================= */

function ensureLayers(): void {
  if (!S.map || typeof L === 'undefined') return;
  if (!savedPolygonsLayer) {
    savedPolygonsLayer = L.layerGroup().addTo(S.map);
  }
  if (!tempPolygonLayer) {
    tempPolygonLayer = L.layerGroup().addTo(S.map);
  }
  if (!tempMarkersLayer) {
    tempMarkersLayer = L.layerGroup().addTo(S.map);
  }
  if (!unassignedPinsLayer) {
    unassignedPinsLayer = L.layerGroup().addTo(S.map);
  }
}

export function startPolygonDrawing(): void {
  if (!S.map) {
    toast('El mapa no está listo aún.', 'warn');
    return;
  }
  ensureLayers();

  // Asegurar vista de todas las rutas para apreciar todos los puntos
  if (S.viewMode !== 'all') {
    drawAllRoutes({ preserveView: true });
  }

  // Limpiar lazo previo para nuevo trazo
  polygonState.polygons = [];
  polygonState.currentVertices = [];
  polygonState.isDrawing = true;

  if (tempPolygonLayer) tempPolygonLayer.clearLayers();
  if (tempMarkersLayer) tempMarkersLayer.clearLayers();
  if (savedPolygonsLayer) savedPolygonsLayer.clearLayers();

  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.cursor = 'crosshair';

  S.map.off('click', handleMapClickForDrawing);
  S.map.on('click', handleMapClickForDrawing);

  renderPolygonToolbarUI();
  toast('Haz clic en el mapa para trazar el lazo. Puedes arrastrar las esquinas en vivo.', 'info');
}

function handleMapClickForDrawing(e: any): void {
  if (!polygonState.isDrawing) return;
  // Si acabamos de soltar un vértice, evitar agregar punto extra
  if (isDraggingVertex || Date.now() - lastVertexDragEndTime < 160) {
    return;
  }

  const lat = Number(e.latlng.lat.toFixed(6));
  const lng = Number(e.latlng.lng.toFixed(6));
  polygonState.currentVertices.push([lat, lng]);

  rebuildTempDrawingMarkers();
  refreshTempDrawingShape();
  renderPolygonToolbarUI();
}

function rebuildTempDrawingMarkers(): void {
  if (!tempMarkersLayer || typeof L === 'undefined') return;
  tempMarkersLayer.clearLayers();

  const total = polygonState.currentVertices.length;
  polygonState.currentVertices.forEach((pt, idx) => {
    const isFirst = idx === 0 && total >= 3;
    const vertexMarker = L.marker([pt[0], pt[1]], {
      draggable: true,
      zIndexOffset: 10000 + idx
    });

    const iconHtml = `
      <div class="lasso-vertex-handle" style="width:24px;height:24px;border-radius:50%;background:${isFirst ? '#10B981' : '#EA580C'};border:2.5px solid #FFFFFF;box-shadow:0 0 10px rgba(0,0,0,0.45);cursor:move;display:flex;align-items:center;justify-content:center;color:#FFFFFF;font-size:10px;font-weight:900;user-select:none;">
        ${isFirst ? '✓' : idx + 1}
      </div>
    `;

    vertexMarker.setIcon(
      L.divIcon({
        className: 'lasso-vertex-icon-wrapper',
        html: iconHtml,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      })
    );

    vertexMarker.on('dragstart', () => {
      isDraggingVertex = true;
    });

    vertexMarker.on('drag', (ev: any) => {
      const pos = ev.target.getLatLng();
      polygonState.currentVertices[idx] = [Number(pos.lat.toFixed(6)), Number(pos.lng.toFixed(6))];
      refreshTempDrawingShape();
      renderPolygonToolbarUI();
    });

    vertexMarker.on('dragend', () => {
      lastVertexDragEndTime = Date.now();
      setTimeout(() => {
        isDraggingVertex = false;
      }, 120);
      refreshTempDrawingShape();
      renderPolygonToolbarUI();
    });

    // Clic en el primer vértice cierra el polígono
    if (idx === 0) {
      vertexMarker.on('click', (ev: any) => {
        if (ev && ev.originalEvent) {
          ev.originalEvent.stopPropagation();
        }
        if (polygonState.currentVertices.length >= 3) {
          finishPolygonDrawing();
        }
      });
    }

    tempMarkersLayer.addLayer(vertexMarker);
  });
}

function refreshTempDrawingShape(): void {
  if (!tempPolygonLayer || typeof L === 'undefined') return;
  tempPolygonLayer.clearLayers();

  const pts = polygonState.currentVertices;
  if (!pts || !pts.length) return;

  if (pts.length === 1) {
    tempPolygonLayer.addLayer(
      L.circleMarker([pts[0][0], pts[0][1]], {
        radius: 6,
        color: '#EA580C',
        fillColor: '#EA580C',
        fillOpacity: 0.8
      })
    );
  } else if (pts.length === 2) {
    tempPolygonLayer.addLayer(
      L.polyline(pts, {
        color: '#EA580C',
        weight: 3,
        dashArray: '6, 6',
        opacity: 0.95
      })
    );
  } else {
    tempPolygonLayer.addLayer(
      L.polygon(pts, {
        color: '#EA580C',
        weight: 3,
        dashArray: '6, 6',
        fillColor: '#EA580C',
        fillOpacity: 0.16
      })
    );
  }
}

export function undoLastDrawingVertex(ev?: Event): void {
  if (ev) {
    ev.stopPropagation();
    ev.preventDefault();
  }

  if (polygonState.isDrawing) {
    if (polygonState.currentVertices.length > 0) {
      polygonState.currentVertices.pop();
      rebuildTempDrawingMarkers();
      refreshTempDrawingShape();
      renderPolygonToolbarUI();
    }
    return;
  }

  // Si el lazo ya estaba cerrado, lo reabre para editar
  if (polygonState.polygons.length > 0) {
    const p = polygonState.polygons[0];
    polygonState.currentVertices = [...p.vertices];
    polygonState.currentVertices.pop();
    polygonState.polygons = [];
    polygonState.isDrawing = true;

    if (savedPolygonsLayer) savedPolygonsLayer.clearLayers();
    rebuildTempDrawingMarkers();
    refreshTempDrawingShape();
    renderPolygonToolbarUI();
    toast('Lazo reabierto para edición de puntos', 'info');
  }
}

export function finishPolygonDrawing(): void {
  if (polygonState.currentVertices.length < 3) {
    toast('Se requieren al menos 3 puntos para cerrar el lazo.', 'warn');
    return;
  }

  polygonState.isDrawing = false;
  if (S.map) {
    S.map.off('click', handleMapClickForDrawing);
  }

  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.cursor = '';

  const closedVertices = [...polygonState.currentVertices];
  polygonState.currentVertices = [];
  if (tempMarkersLayer) tempMarkersLayer.clearLayers();
  if (tempPolygonLayer) tempPolygonLayer.clearLayers();

  const newPoly: PolygonItem = {
    id: `lasso-${Date.now()}`,
    name: 'Lazo 1',
    color: '#EA580C',
    vertices: closedVertices
  };

  polygonState.polygons = [newPoly];
  renderPolygonsOnMap();
  renderPolygonToolbarUI();

  const inside = getDestinationsInsidePolygon(closedVertices, true);
  toast(`Lazo cerrado: ${inside.length} cliente(s) encerrados disponibles.`, 'success');
}

export function cancelPolygonDrawing(): void {
  polygonState.isDrawing = false;
  polygonState.currentVertices = [];
  polygonState.polygons = [];

  if (S.map) {
    S.map.off('click', handleMapClickForDrawing);
  }
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.cursor = '';

  if (tempMarkersLayer) tempMarkersLayer.clearLayers();
  if (tempPolygonLayer) tempPolygonLayer.clearLayers();
  if (savedPolygonsLayer) savedPolygonsLayer.clearLayers();

  renderPolygonToolbarUI();
  toast('Trazado de lazo cancelado.', 'info');
}

export function clearAllPolygons(keepRoutes = true): void {
  polygonState.isDrawing = false;
  polygonState.currentVertices = [];
  polygonState.polygons = [];

  if (S.map) {
    S.map.off('click', handleMapClickForDrawing);
  }
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.style.cursor = '';

  if (tempMarkersLayer) tempMarkersLayer.clearLayers();
  if (tempPolygonLayer) tempPolygonLayer.clearLayers();
  if (savedPolygonsLayer) savedPolygonsLayer.clearLayers();

  renderPolygonToolbarUI();
}

/* =========================================================================
   C. ACCIONES AL CERRAR EL LAZO (REORGANIZACIÓN Y BLINDAJE)
   ========================================================================= */

export async function createRoutesFromPolygon(): Promise<void> {
  const poly = polygonState.polygons[0];
  if (!poly) {
    toast('No hay ningún lazo activo.', 'warn');
    return;
  }

  const insideStops = getDestinationsInsidePolygon(poly.vertices, true);
  if (!insideStops.length) {
    toast('No se encontraron clientes disponibles dentro del lazo.', 'warn');
    return;
  }

  await withJamarLoader(() => {
    // 1. Conservar intactas las rutas previamente fijadas
    const previouslyLockedRoutes = (S.routes || []).filter(r => r.lockedByLasso);
    const lockedStopIds = getLockedLassoStopIds();
    const insideIds = new Set(insideStops.map(s => s.id));

    // 2. Agrupar los clientes encerrados en nuevas rutas blindadas (respetando hasta 15 paradas / 18 m³ en 1 ruta)
    insideStops.forEach(d => {
      d.zone = classifyZone(d);
    });
    const newLassoGroups = groupPolygonStops(insideStops);
    const newLassoRoutes = newLassoGroups.map(stops => {
      const x = alternatives(stops);
      return {
        color: '#EA580C',
        stops,
        alts: x,
        option: x.chosen,
        visible: true,
        lockedByLasso: true
      };
    });

    // 3. Re-agrupar los destinos restantes desbloqueados
    const validAll = (S.destinations || []).filter(d => d.lat && d.lng);
    const remainingUnlockedStops = validAll.filter(d => !lockedStopIds.has(d.id) && !insideIds.has(d.id));
    remainingUnlockedStops.forEach(d => {
      d.zone = classifyZone(d);
    });
    const outsideGroups = remainingUnlockedStops.length ? clusterStrictZones(remainingUnlockedStops) : [];
    const outsideRoutes = outsideGroups.map(stops => {
      const x = alternatives(stops);
      return {
        stops,
        alts: x,
        option: x.chosen,
        visible: true,
        lockedByLasso: false
      };
    });

    // 4. Limpiar el dibujo del lazo y reconstruir S.routes
    clearAllPolygons(true);
    const combined = [...previouslyLockedRoutes, ...newLassoRoutes, ...outsideRoutes];
    S.routes = combined.map((r: any, idx: number) => {
      r.id = idx;
      r.color = r.color || S.colors[idx % S.colors.length];
      if (!r.alts) r.alts = alternatives(active(r));
      if (!r.option) r.option = r.alts.chosen;
      r.visible = true;
      return r;
    });

    deduplicateFleetStops();
    renderRoutes();
    drawAllRoutes();
    syncAllRoutesRealDistance();
    publishRoutesToTelemetryServer();
    renderUnassignedPinsOnMap();
    renderPolygonToolbarUI();
    toast(`✅ ${newLassoRoutes.length} ruta(s) fijadas con el lazo. El resto de la flota fue re-zonificado.`, 'success');
  }, 'LAZO JAMAR', 'Fijando ruta de lazo y re-zonificando flota...', 1400);
}

export async function isolateSinglePolygon(): Promise<void> {
  const poly = polygonState.polygons[0];
  if (!poly) {
    toast('No hay ningún lazo activo.', 'warn');
    return;
  }

  const insideStops = getDestinationsInsidePolygon(poly.vertices, true);
  if (!insideStops.length) {
    toast('No hay clientes disponibles dentro del lazo.', 'warn');
    return;
  }

  await withJamarLoader(() => {
    // Conservar las rutas bloqueadas previamente + crear rutas para el lazo actual
    const previouslyLockedRoutes = (S.routes || []).filter(r => r.lockedByLasso);
    insideStops.forEach(d => {
      d.zone = classifyZone(d);
    });
    const newLassoGroups = groupPolygonStops(insideStops);
    const newLassoRoutes = newLassoGroups.map(stops => {
      const x = alternatives(stops);
      return {
        color: '#EA580C',
        stops,
        alts: x,
        option: x.chosen,
        visible: true,
        lockedByLasso: true
      };
    });

    clearAllPolygons(true);
    const combined = [...previouslyLockedRoutes, ...newLassoRoutes];
    S.routes = combined.map((r: any, idx: number) => {
      r.id = idx;
      r.color = r.color || S.colors[idx % S.colors.length];
      if (!r.alts) r.alts = alternatives(active(r));
      if (!r.option) r.option = r.alts.chosen;
      r.visible = true;
      return r;
    });

    deduplicateFleetStops();
    renderRoutes();
    drawAllRoutes();
    syncAllRoutesRealDistance();
    publishRoutesToTelemetryServer();
    renderUnassignedPinsOnMap();
    renderPolygonToolbarUI();
    toast('🎯 Se conservaron únicamente las rutas fijadas. Los demás clientes quedaron como pines libres.', 'success');
  }, 'AISLAR LAZO', 'Fijando lazo y liberando paradas restantes...', 1300);
}

export function movePolygonStopsToRoute(targetRouteId: number): void {
  const poly = polygonState.polygons[0];
  if (!poly) return;

  const insideStops = getDestinationsInsidePolygon(poly.vertices, true);
  if (!insideStops.length) {
    toast('No hay paradas dentro del lazo para transferir.', 'warn');
    return;
  }

  const target = (S.routes || []).find(r => r.id === targetRouteId);
  if (!target) {
    toast('La ruta destino no existe.', 'error');
    return;
  }

  const currentStops = active(target);
  const totalStops = currentStops.length + insideStops.length;
  const totalVol = vol(currentStops) + vol(insideStops);

  if (totalStops > MAX_DEST) {
    toast(`Excede el límite de paradas: ${totalStops}/${MAX_DEST}`, 'warn');
    return;
  }
  if (totalVol > MAX_VOL) {
    toast(`Excede el volumen máximo: ${totalVol.toFixed(2)}/${MAX_VOL} m³`, 'warn');
    return;
  }

  // Quitar insideStops de cualquier ruta previa donde estuvieran
  const insideIds = new Set(insideStops.map(s => s.id));
  (S.routes || []).forEach(r => {
    if (r.id !== targetRouteId && r.alts) {
      if (r.alts.a) r.alts.a = r.alts.a.filter((s: any) => !insideIds.has(s.id));
      if (r.alts.b) r.alts.b = r.alts.b.filter((s: any) => !insideIds.has(s.id));
    }
  });

  const merged = [...currentStops, ...insideStops];
  target.alts = alternatives(merged);
  target.option = target.alts.chosen;
  target.lockedByLasso = true;
  delete target._osrmCache;

  clearAllPolygons(true);
  deduplicateFleetStops();
  renderRoutes();
  draw(target);
  syncAllRoutesRealDistance();
  renderUnassignedPinsOnMap();
  renderPolygonToolbarUI();
  toast(`✅ ${insideStops.length} paradas movidas a Ruta ${target.id + 1} (🔒 Fijada).`, 'success');
}

/* =========================================================================
   D. PINES LIBRES (⚪ Sin ruta) Y ADICIÓN EN 1 CLIC
   ========================================================================= */

export function getUnassignedDestinations(): PhysicalDestination[] {
  if (!S.destinations || !S.destinations.length) return [];
  const assignedIds = new Set<number>();
  (S.routes || []).forEach(r => {
    active(r).forEach((s: any) => {
      if (s && s.id !== undefined) assignedIds.add(s.id);
    });
  });

  return S.destinations.filter(d => d.lat && d.lng && d.vol <= MAX_VOL && !assignedIds.has(d.id));
}

export function renderUnassignedPinsOnMap(): void {
  ensureLayers();
  if (!unassignedPinsLayer || typeof L === 'undefined') return;
  unassignedPinsLayer.clearLayers();

  const unassigned = getUnassignedDestinations();
  unassigned.forEach(d => {
    const iconHtml = `
      <div style="background:#FFFFFF;color:#334155;border:1.5px solid #94A3B8;border-radius:9999px;padding:3px 8px;font-size:10px;font-weight:800;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.25);transform:translate(-50%, -50%);display:inline-flex;align-items:center;gap:4px;user-select:none;cursor:pointer;">
        <span>⚪</span>
        <span>Sin ruta · ${d.vol.toFixed(1)}m³</span>
      </div>
    `;

    const marker = L.marker([d.lat, d.lng], {
      icon: L.divIcon({
        className: 'unassigned-stop-pin-wrapper',
        html: iconHtml,
        iconSize: [0, 0]
      }),
      zIndexOffset: 8000
    });

    marker.bindPopup(() => renderUnassignedStopPopupHtml(d), {
      maxWidth: 320,
      className: 'jamar-custom-popup'
    });

    unassignedPinsLayer.addLayer(marker);
  });
}

export function renderUnassignedStopPopupHtml(d: PhysicalDestination): string {
  const eligibleRoutes: Array<{ routeId: number; distKm: number; freeSlots: number; freeVol: number }> = [];

  (S.routes || []).forEach(r => {
    const st = active(r);
    const freeSlots = MAX_DEST - st.length;
    const currentVol = vol(st);
    const freeVol = MAX_VOL - currentVol;

    if (freeSlots > 0 && freeVol >= d.vol) {
      const distKm = avgDistToCluster(d, st);
      eligibleRoutes.push({
        routeId: r.id,
        distKm,
        freeSlots,
        freeVol
      });
    }
  });

  eligibleRoutes.sort((a, b) => a.distKm - b.distKm);

  let buttonsHtml = '';
  if (eligibleRoutes.length) {
    buttonsHtml = eligibleRoutes
      .slice(0, 4)
      .map(
        er => `
        <button type="button" onclick="window.addStopDirectlyToRoute && window.addStopDirectlyToRoute(${d.id}, ${er.routeId})" class="w-full text-left px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-orange-50 dark:hover:bg-slate-700/80 text-xs font-medium transition flex items-center justify-between gap-1 cursor-pointer">
          <span class="font-bold text-[#EA580C]">➕ Ruta ${er.routeId + 1}</span>
          <span class="text-[10px] text-slate-500">${er.distKm.toFixed(1)} km · ${er.freeSlots} cupos · ${er.freeVol.toFixed(1)}m³</span>
        </button>
      `
      )
      .join('');
  } else {
    buttonsHtml = '<p class="text-[11px] text-slate-400 italic">No hay rutas existentes con cupo disponible.</p>';
  }

  return `
    <div class="p-2 space-y-2 text-slate-800 dark:text-slate-100 min-w-[240px]">
      <div class="border-b border-slate-200 dark:border-slate-700 pb-1.5">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200">⚪ Cliente sin ruta asignada</span>
        <h4 class="font-bold text-xs mt-1 text-slate-900 dark:text-white">${esc(d.cliente || 'CLIENTE JAMAR')}</h4>
        <p class="text-[11px] text-slate-500 dark:text-slate-400">${esc(d.direccion)} (${esc(d.ciudad)})</p>
        <p class="text-[11px] font-semibold text-blue-600 dark:text-blue-400 mt-0.5">📦 Volumen: ${d.vol.toFixed(2)} m³</p>
      </div>

      <div class="space-y-1">
        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Añadir a ruta con cupo:</p>
        <div class="space-y-1 max-h-36 overflow-y-auto">${buttonsHtml}</div>
      </div>

      <div class="pt-1.5 border-t border-slate-200 dark:border-slate-700">
        <button type="button" onclick="window.createNewRouteWithSingleStop && window.createNewRouteWithSingleStop(${d.id})" class="w-full py-1.5 px-3 rounded-lg bg-[#EA580C] hover:bg-[#D94E06] text-white text-xs font-bold text-center shadow-xs transition cursor-pointer flex items-center justify-center gap-1.5">
          <span>🚛</span>
          <span>Crear nueva ruta con este cliente</span>
        </button>
      </div>
    </div>
  `;
}

export function addStopDirectlyToRoute(stopId: number, targetRouteId: number): void {
  const target = (S.routes || []).find(r => r.id === targetRouteId);
  if (!target) return;

  const currentStops = active(target);
  const d = (S.destinations || []).find(x => x.id === stopId);
  if (!d) return;

  if (currentStops.length + 1 > MAX_DEST) {
    toast(`La Ruta ${target.id + 1} ya tiene el máximo de 15 paradas.`, 'warn');
    return;
  }
  if (vol(currentStops) + d.vol > MAX_VOL) {
    toast(`Excede el límite de volumen de 18 m³.`, 'warn');
    return;
  }

  // Quitar de cualquier ruta previa si estuviera
  (S.routes || []).forEach(r => {
    if (r.id !== targetRouteId && r.alts) {
      if (r.alts.a) r.alts.a = r.alts.a.filter((s: any) => s.id !== stopId);
      if (r.alts.b) r.alts.b = r.alts.b.filter((s: any) => s.id !== stopId);
    }
  });

  const merged = [...currentStops, d];
  target.alts = alternatives(merged);
  target.option = target.alts.chosen;
  delete target._osrmCache;

  deduplicateFleetStops();
  renderRoutes();
  draw(target);
  syncAllRoutesRealDistance();
  renderUnassignedPinsOnMap();
  renderPolygonToolbarUI();
  toast(`✅ Cliente añadido exitosamente a Ruta ${target.id + 1}`, 'success');
}

export function createNewRouteWithSingleStop(stopId: number): void {
  const d = (S.destinations || []).find(x => x.id === stopId);
  if (!d) return;

  // Quitar de otras rutas si estuviera
  (S.routes || []).forEach(r => {
    if (r.alts) {
      if (r.alts.a) r.alts.a = r.alts.a.filter((s: any) => s.id !== stopId);
      if (r.alts.b) r.alts.b = r.alts.b.filter((s: any) => s.id !== stopId);
    }
  });

  const nextId = S.routes ? S.routes.length : 0;
  const x = alternatives([d]);
  const newRoute: any = {
    id: nextId,
    color: S.colors[nextId % S.colors.length],
    stops: [d],
    alts: x,
    option: x.chosen,
    visible: true,
    lockedByLasso: false
  };

  S.routes.push(newRoute);
  deduplicateFleetStops();
  renderRoutes();
  draw(newRoute);
  syncAllRoutesRealDistance();
  renderUnassignedPinsOnMap();
  renderPolygonToolbarUI();
  toast(`🚛 Nueva Ruta ${nextId + 1} creada con este cliente.`, 'success');
}

export function removeStopToUnassignedPool(stopId: number): void {
  let changed = false;
  let fromRouteId = -1;

  (S.routes || []).forEach(r => {
    const hadInA = r.alts?.a?.some((s: any) => s.id === stopId);
    const hadInB = r.alts?.b?.some((s: any) => s.id === stopId);

    if (hadInA || hadInB) {
      fromRouteId = r.id;
      if (r.alts?.a) r.alts.a = r.alts.a.filter((s: any) => s.id !== stopId);
      if (r.alts?.b) r.alts.b = r.alts.b.filter((s: any) => s.id !== stopId);
      delete r._osrmCache;
      changed = true;
    }
  });

  if (!changed) {
    toast('La parada ya se encuentra libre.', 'info');
    return;
  }

  // Filtrar rutas que hayan quedado vacías
  S.routes = (S.routes || []).filter(r => active(r).length > 0);
  S.routes.forEach((r: any, idx: number) => {
    r.id = idx;
    r.alts = alternatives(active(r));
    r.option = r.alts.chosen;
  });

  deduplicateFleetStops();
  renderRoutes();
  drawAllRoutes();
  syncAllRoutesRealDistance();
  publishRoutesToTelemetryServer();
  renderUnassignedPinsOnMap();
  renderPolygonToolbarUI();
  toast(`⚪ Parada soltada al mapa como pin libre (Ruta ${fromRouteId + 1} actualizada).`, 'info');
}

/* =========================================================================
   E. RENDERIZADO EN MAPA Y CÁPSULA FLOTANTE SUPERIOR
   ========================================================================= */

export function renderPolygonsOnMap(): void {
  ensureLayers();
  if (!savedPolygonsLayer || typeof L === 'undefined') return;
  savedPolygonsLayer.clearLayers();

  polygonState.polygons.forEach(p => {
    const inside = getDestinationsInsidePolygon(p.vertices, true);
    const totalVol = vol(inside);
    const totalDeliveries = inside.reduce((sum, s) => sum + ((s as any).entregas?.length || 1), 0);
    const deliveryDetail = totalDeliveries > inside.length ? ` (${totalDeliveries} entregas)` : '';

    const polyLayer = L.polygon(p.vertices, {
      color: p.color || '#EA580C',
      weight: 3.5,
      dashArray: '8, 6',
      fillColor: p.color || '#EA580C',
      fillOpacity: 0.18
    });

    // Calcular centroide para etiqueta informativa
    const cLat = p.vertices.reduce((acc, v) => acc + v[0], 0) / p.vertices.length;
    const cLng = p.vertices.reduce((acc, v) => acc + v[1], 0) / p.vertices.length;

    const centerMarker = L.marker([cLat, cLng], {
      icon: L.divIcon({
        className: 'lasso-center-badge-wrapper',
        html: `
          <div style="background:rgba(15,23,42,0.92);color:#FFFFFF;border:2px solid #EA580C;border-radius:9999px;padding:4px 10px;font-size:11px;font-weight:800;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.4);transform:translate(-50%, -50%);display:inline-flex;align-items:center;gap:5px;pointer-events:none;">
            <span>📐 ${p.name}</span>
            <span style="color:#FB923C;">${inside.length} paradas${deliveryDetail} · ${totalVol.toFixed(1)}m³</span>
          </div>
        `,
        iconSize: [0, 0]
      }),
      zIndexOffset: 9000
    });

    savedPolygonsLayer.addLayer(polyLayer);
    savedPolygonsLayer.addLayer(centerMarker);
  });
}

export function renderPolygonToolbarUI(): void {
  const mapBar = document.getElementById('polygonGeofenceMapBar');
  const sidebarBox = document.getElementById('sidebarPolygonControlBox');

  if (mapBar && (window as any).L) {
    L.DomEvent.disableClickPropagation(mapBar);
    mapBar.style.pointerEvents = 'auto';
  }

  const lockedCount = (S.routes || []).filter(r => r.lockedByLasso).length;
  const unassignedCount = getUnassignedDestinations().length;

  // 1. Barra Flotante sobre el Mapa (#polygonGeofenceMapBar)
  if (mapBar) {
    if (polygonState.isDrawing) {
      const vCount = polygonState.currentVertices.length;
      const inside = vCount >= 3 ? getDestinationsInsidePolygon(polygonState.currentVertices, true) : [];
      const totalVol = vol(inside);
      const totalDeliveries = inside.reduce((sum, s) => sum + ((s as any).entregas?.length || 1), 0);
      const deliveryDetail = totalDeliveries > inside.length ? ` (${totalDeliveries} entregas)` : '';

      mapBar.innerHTML = `
        <div class="inline-flex items-center gap-2 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-orange-300 dark:border-orange-600/60 px-3 py-1.5 rounded-full shadow-lg text-[11px] text-slate-800 dark:text-slate-100 flex-wrap">
          <span class="font-extrabold text-[#EA580C] flex items-center gap-1">
            <span class="animate-pulse">●</span>
            <span>Dibujando Lazo (${vCount} pts)</span>
          </span>
          ${vCount >= 3 ? `<span class="px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-950 text-orange-900 dark:text-orange-200 font-bold whitespace-nowrap">${inside.length} paradas${deliveryDetail} · ${totalVol.toFixed(1)} m³</span>` : '<span class="text-slate-400 italic">Haz clic en el mapa para agregar esquinas</span>'}
          <div class="flex items-center gap-1.5 ml-1">
            ${vCount >= 3 ? `<button type="button" onclick="window.finishPolygonDrawing && window.finishPolygonDrawing()" class="px-3 py-1 rounded-full bg-[#EA580C] hover:bg-[#D94E06] text-white font-bold transition shadow-xs cursor-pointer">✓ Cerrar Lazo</button>` : ''}
            ${vCount > 0 ? `<button type="button" onclick="window.undoLastDrawingVertex && window.undoLastDrawingVertex(event)" class="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-semibold transition cursor-pointer" title="Deshacer último punto">↶ Deshacer</button>` : ''}
            <button type="button" onclick="window.cancelPolygonDrawing && window.cancelPolygonDrawing()" class="px-2.5 py-1 rounded-full text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition cursor-pointer">✕ Cancelar</button>
          </div>
        </div>
      `;
    } else if (polygonState.polygons.length > 0) {
      const p = polygonState.polygons[0];
      const inside = getDestinationsInsidePolygon(p.vertices, true);
      const totalVol = vol(inside);
      const totalDeliveries = inside.reduce((sum, s) => sum + ((s as any).entregas?.length || 1), 0);
      const deliveryDetail = totalDeliveries > inside.length ? ` (${totalDeliveries} entregas)` : '';

      // Opciones de rutas disponibles para mover
      const routeOptions = (S.routes || [])
        .map(
          r => `
          <option value="${r.id}">Mover a Ruta ${r.id + 1} (${active(r).length}p · ${vol(active(r)).toFixed(1)}m³)</option>
        `
        )
        .join('');

      mapBar.innerHTML = `
        <div class="inline-flex items-center gap-2 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200/90 dark:border-slate-700 px-3.5 py-2 rounded-2xl shadow-xl text-[11px] text-slate-800 dark:text-slate-100 flex-wrap">
          <div class="flex items-center gap-1.5 font-bold">
            <span class="text-orange-500 text-sm">📐</span>
            <span>Lazo Cerrado:</span>
            <span class="text-[#EA580C] font-extrabold whitespace-nowrap">${inside.length} paradas${deliveryDetail} · ${totalVol.toFixed(1)} m³</span>
          </div>

          <div class="flex items-center gap-1.5 flex-wrap">
            <button type="button" onclick="window.createRoutesFromPolygon && window.createRoutesFromPolygon()" class="px-3 py-1 rounded-full bg-[#EA580C] hover:bg-[#D94E06] text-white font-bold transition shadow-xs flex items-center gap-1 cursor-pointer" title="Fijar este lazo y re-armar el resto con clusterStrictZones">
              <span>🔄</span>
              <span>Hacer Ruta y Re-armar Resto</span>
            </button>

            <button type="button" onclick="window.isolateSinglePolygon && window.isolateSinglePolygon()" class="px-3 py-1 rounded-full bg-slate-800 hover:bg-slate-900 text-white dark:bg-slate-700 dark:hover:bg-slate-600 font-bold transition shadow-xs flex items-center gap-1 cursor-pointer" title="Dejar solo lo encerrado y soltar el resto de paradas como pines libres">
              <span>🎯</span>
              <span>Dejar solo lo encerrado</span>
            </button>

            ${(S.routes || []).length ? `
              <div class="inline-flex items-center gap-1">
                <select id="lassoMoveSelect" class="px-2 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 font-medium">
                  ${routeOptions}
                </select>
                <button type="button" onclick="const sel = document.getElementById('lassoMoveSelect'); if(sel && window.movePolygonStopsToRoute) window.movePolygonStopsToRoute(Number(sel.value));" class="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition cursor-pointer">
                  Mover
                </button>
              </div>
            ` : ''}

            <button type="button" onclick="window.undoLastDrawingVertex && window.undoLastDrawingVertex(event)" class="px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-semibold transition cursor-pointer" title="Reabrir lazo y editar esquinas">
              ↶ Editar
            </button>

            <button type="button" onclick="window.clearAllPolygons && window.clearAllPolygons(true)" class="px-2.5 py-1 rounded-full text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition cursor-pointer" title="Descartar lazo">
              ✕
            </button>
          </div>
        </div>
      `;
    } else {
      // Estado en reposo sobre el mapa
      mapBar.innerHTML = `
        <div class="inline-flex items-center gap-1.5 bg-white/95 dark:bg-slate-800/95 backdrop-blur-md border border-slate-200/90 dark:border-slate-700 px-3 py-1 rounded-full shadow-md text-[11px] pointer-events-auto">
          <button type="button" onclick="window.startPolygonDrawing && window.startPolygonDrawing()" class="inline-flex items-center gap-1.5 text-xs font-bold text-[#EA580C] hover:text-[#D94E06] transition cursor-pointer">
            <span>✏️</span>
            <span>Dibujar Lazo / Polígono</span>
          </button>
          ${lockedCount > 0 ? `
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <button type="button" onclick="window.unlockAllLassoRoutes && window.unlockAllLassoRoutes()" class="text-[10px] font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition cursor-pointer" title="Liberar blindaje de todas las rutas fijadas">
              🔓 Desbloquear fijadas (${lockedCount})
            </button>
          ` : ''}
          ${unassignedCount > 0 ? `
            <span class="text-slate-300 dark:text-slate-600">|</span>
            <span class="text-[10px] font-bold text-amber-600 dark:text-amber-400">⚪ ${unassignedCount} libres</span>
          ` : ''}
        </div>
      `;
    }
  }

  // 2. Control en el panel lateral (#sidebarPolygonControlBox)
  if (sidebarBox) {
    sidebarBox.innerHTML = `
      <div class="p-3 rounded-2xl bg-slate-50/80 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400">SELECCIÓN POR LAZO</span>
          ${lockedCount > 0 ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300">🔒 ${lockedCount} fijada(s)</span>` : ''}
        </div>

        <button type="button" onclick="window.startPolygonDrawing && window.startPolygonDrawing()" class="w-full py-2 px-3 rounded-xl bg-white dark:bg-slate-700 hover:bg-orange-50 dark:hover:bg-slate-600 border border-slate-200 dark:border-slate-600 text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center justify-center gap-2 shadow-2xs transition cursor-pointer">
          <span class="text-sm">✏️</span>
          <span>${polygonState.isDrawing ? 'Dibujando en el mapa...' : 'Dibujar Lazo en el Mapa'}</span>
        </button>

        ${lockedCount > 0 ? `
          <button type="button" onclick="window.unlockAllLassoRoutes && window.unlockAllLassoRoutes()" class="w-full py-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition cursor-pointer text-center">
            🔓 Desbloquear todas las rutas fijadas
          </button>
        ` : ''}
      </div>
    `;
  }
}

// Registro global en window para invocación desde HTML y popups
if (typeof window !== 'undefined') {
  (window as any).startPolygonDrawing = startPolygonDrawing;
  (window as any).undoLastDrawingVertex = undoLastDrawingVertex;
  (window as any).finishPolygonDrawing = finishPolygonDrawing;
  (window as any).cancelPolygonDrawing = cancelPolygonDrawing;
  (window as any).clearAllPolygons = clearAllPolygons;
  (window as any).createRoutesFromPolygon = createRoutesFromPolygon;
  (window as any).isolateSinglePolygon = isolateSinglePolygon;
  (window as any).movePolygonStopsToRoute = movePolygonStopsToRoute;
  (window as any).toggleRouteLassoLock = toggleRouteLassoLock;
  (window as any).unlockAllLassoRoutes = unlockAllLassoRoutes;
  (window as any).addStopDirectlyToRoute = addStopDirectlyToRoute;
  (window as any).createNewRouteWithSingleStop = createNewRouteWithSingleStop;
  (window as any).removeStopToUnassignedPool = removeStopToUnassignedPool;
  (window as any).renderPolygonsOnMap = renderPolygonsOnMap;
  (window as any).renderPolygonToolbarUI = renderPolygonToolbarUI;
  (window as any).renderUnassignedPinsOnMap = renderUnassignedPinsOnMap;
}
