import { DEPOT, OSRM_URL } from '../config/constants';
import { DeliveryRoute, PhysicalDestination } from '../types';
import { esc, S, safeSet, toast } from '../state/store';
import { active, isReturnDepot } from '../services/routing';
import { applyRealDistanceToRoute } from '../services/osrm';
import { normText } from '../config/zones';

declare const L: any;

export const MAP_LAYERS = {
  roadmap: {
    url: 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
    options: {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      crossOrigin: true,
      attribution: '© Google Maps'
    }
  },
  satellite: {
    url: 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    options: {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      crossOrigin: true,
      attribution: '© Google Maps'
    }
  }
};

export let currentMapLayer = 'roadmap';

export function updateLayerButtonsUI(activeKey: string): void {
  const btnRoadmap = document.getElementById('btnLayerRoadmap');
  const btnSatellite = document.getElementById('btnLayerSatellite');
  if (!btnRoadmap || !btnSatellite) return;

  const activeClasses = ['bg-white', 'text-slate-900', 'dark:bg-slate-700', 'dark:text-white', 'font-semibold', 'shadow-xs'];
  const inactiveClasses = ['text-slate-600', 'dark:text-slate-300', 'font-medium', 'hover:text-slate-900', 'dark:hover:text-white'];

  if (activeKey === 'roadmap') {
    btnRoadmap.classList.add(...activeClasses);
    btnRoadmap.classList.remove(...inactiveClasses);
    btnSatellite.classList.remove(...activeClasses);
    btnSatellite.classList.add(...inactiveClasses);
  } else {
    btnSatellite.classList.add(...activeClasses);
    btnSatellite.classList.remove(...inactiveClasses);
    btnRoadmap.classList.remove(...activeClasses);
    btnRoadmap.classList.add(...inactiveClasses);
  }
}

export function switchMapTile(layerKey = 'roadmap'): void {
  currentMapLayer = layerKey;
  updateLayerButtonsUI(layerKey);
  if (!S.map) return;
  if (S.tiles) {
    S.map.removeLayer(S.tiles);
  }
  const cfg = (MAP_LAYERS as any)[layerKey] || MAP_LAYERS.roadmap;
  S.tiles = L.tileLayer(cfg.url, cfg.options).addTo(S.map);
  S.tiles.bringToBack();
}

export function updatePinSizeModeUI(activeSize = 'micro'): void {
  const btnMicro = document.getElementById('btnPinSizeMicro');
  const btnStd = document.getElementById('btnPinSizeStandard');
  if (!btnMicro || !btnStd) return;

  const activeClasses = ['bg-blue-600', 'text-white', 'font-bold', 'shadow-xs'];
  const inactiveClasses = ['text-slate-600', 'dark:text-slate-300', 'font-medium', 'hover:text-slate-900', 'dark:hover:text-white'];

  if (activeSize === 'micro') {
    btnMicro.classList.add(...activeClasses);
    btnMicro.classList.remove(...inactiveClasses);
    btnStd.classList.remove(...activeClasses);
    btnStd.classList.add(...inactiveClasses);
  } else {
    btnStd.classList.add(...activeClasses);
    btnStd.classList.remove(...inactiveClasses);
    btnMicro.classList.remove(...activeClasses);
    btnMicro.classList.add(...inactiveClasses);
  }
}

export function setPinSizeMode(size = 'micro'): void {
  S.pinSize = size as any;
  safeSet('rutasjamar_pin_size', size);
  updatePinSizeModeUI(size);
  if (!S.map) return;

  const isPines = S.routeViewStyle === 'pines';
  const isMicro = size === 'micro';

  if (S.stopMarkers && S.stopMarkers.length) {
    S.stopMarkers.forEach(m => {
      if (!m || !m._stopData) return;
      const rId = m._stopData.routeId !== undefined && m._stopData.routeId !== null ? m._stopData.routeId : (S.currentRouteIndex ?? 0);
      m.setIcon(getStopMarkerIcon(m._stopData.routeColor, m._stopData.stopIndex, isPines, rId, size as any));

      const tt = m.getTooltip();
      if (tt) {
        const content = tt.getContent();
        m.unbindTooltip();
        m.bindTooltip(content, {
          permanent: false,
          direction: 'top',
          offset: isMicro ? [0, -24] : (isPines ? [0, -36] : [0, -14]),
          className: 'stop-badge-label'
        });
      }
    });
  }
}

export function updateRouteViewStyleUI(activeStyle = 'completo'): void {
  const btnFull = document.getElementById('btnViewStyleFull');
  const btnPins = document.getElementById('btnViewStylePins');
  if (!btnFull || !btnPins) return;

  const activeClasses = ['bg-blue-600', 'text-white', 'font-bold', 'shadow-xs'];
  const inactiveClasses = ['text-slate-600', 'dark:text-slate-300', 'font-medium', 'hover:text-slate-900', 'dark:hover:text-white'];

  if (activeStyle === 'completo') {
    btnFull.classList.add(...activeClasses);
    btnFull.classList.remove(...inactiveClasses);
    btnPins.classList.remove(...activeClasses);
    btnPins.classList.add(...inactiveClasses);
  } else {
    btnPins.classList.add(...activeClasses);
    btnPins.classList.remove(...inactiveClasses);
    btnFull.classList.remove(...activeClasses);
    btnFull.classList.add(...inactiveClasses);
  }
}

export function getStopMarkerIcon(
  routeColor: string,
  stopIndex: number,
  isPinesMode: boolean,
  routeId = 0,
  pinSize: 'micro' | 'estandar' = S.pinSize || 'micro'
): any {
  const rNum = (routeId !== null && routeId !== undefined ? routeId : 0) + 1;
  const sNum = stopIndex + 1;

  if (pinSize === 'micro') {
    return L.divIcon({
      html: `
        <div class="custom-pin-marker" style="width:16px;height:22px;">
          <svg width="16" height="22" viewBox="0 0 16 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M8 21.5C7.3 20.2 1.5 12.8 1.5 8C1.5 4.41015 4.41015 1.5 8 1.5C11.5899 1.5 14.5 4.41015 14.5 8C14.5 12.8 8.7 20.2 8 21.5Z" fill="${routeColor}" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/>
            <circle cx="8" cy="8" r="2.3" fill="#FFFFFF"/>
          </svg>
        </div>
      `,
      className: 'custom-pin-marker-container',
      iconSize: [16, 22],
      iconAnchor: [8, 22]
    });
  }

  if (isPinesMode) {
    return L.divIcon({
      html: `
        <div class="custom-pin-marker" style="width:26px;height:34px;">
          <svg width="26" height="34" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M14 35.5C13.2 34 3 20.8 3 13C3 6.925 7.925 2 14 2C20.075 2 25 6.925 25 13C25 20.8 14.8 34 14 35.5Z" fill="${routeColor}" stroke="#FFFFFF" stroke-width="1.8" stroke-linejoin="round"/>
            <circle cx="14" cy="13" r="8.5" fill="#FFFFFF"/>
            <text x="14" y="13.5" fill="${routeColor}" font-size="${rNum > 9 ? '8.5' : '10'}px" font-family="system-ui, -apple-system, sans-serif" font-weight="900" text-anchor="middle" dominant-baseline="central">R${rNum}</text>
          </svg>
        </div>
      `,
      className: 'custom-pin-marker-container',
      iconSize: [26, 34],
      iconAnchor: [13, 34]
    });
  }

  return L.divIcon({
    html: `
      <div style="background:${routeColor};color:white;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;padding:1px 5px;height:24px;font-size:11px;font-weight:bold;box-shadow:0 2px 5px rgba(0,0,0,0.38);border:2px solid white;white-space:nowrap;gap:2.5px;">
        <span style="background:rgba(255,255,255,0.28);padding:0px 3.5px;border-radius:6px;font-size:9.5px;font-weight:900;letter-spacing:-0.2px">R${rNum}</span>
        <span style="font-size:11px;font-weight:800;padding-right:1px">#${sNum}</span>
      </div>
    `,
    className: '',
    iconSize: [rNum > 9 ? 56 : 50, 24],
    iconAnchor: [rNum > 9 ? 28 : 25, 12]
  });
}

export function setRouteViewStyle(style = 'completo'): void {
  S.routeViewStyle = style as any;
  updateRouteViewStyleUI(style);
  if (!S.map) return;

  const isPines = style === 'pines';
  const isMicro = S.pinSize === 'micro';

  if (isPines) {
    if (S.routeLayer && S.map.hasLayer(S.routeLayer)) {
      S.map.removeLayer(S.routeLayer);
    }
  } else {
    if (S.routeLayer && !S.map.hasLayer(S.routeLayer)) {
      S.map.addLayer(S.routeLayer);
    }
    if (S.routeLayer && S.routeLayer.getLayers().length === 0 && S.routes && S.routes.length) {
      if (S.viewMode === 'all') {
        drawAllRoutes({ preserveView: true });
        return;
      } else {
        const cur = S.routes.find(r => r.id === S.currentRouteIndex);
        if (cur) {
          draw(cur, { preserveView: true });
          return;
        }
      }
    }
  }

  if (S.stopMarkers && S.stopMarkers.length) {
    S.stopMarkers.forEach(m => {
      if (!m || !m._stopData) return;
      const rId = m._stopData.routeId !== undefined && m._stopData.routeId !== null ? m._stopData.routeId : (S.currentRouteIndex ?? 0);
      m.setIcon(getStopMarkerIcon(m._stopData.routeColor, m._stopData.stopIndex, isPines, rId, S.pinSize));

      const tt = m.getTooltip();
      if (tt) {
        const content = tt.getContent();
        m.unbindTooltip();
        m.bindTooltip(content, {
          permanent: false,
          direction: 'top',
          offset: isMicro ? [0, -24] : (isPines ? [0, -36] : [0, -14]),
          className: 'stop-badge-label'
        });
      }
    });
  }
}

export function computeStopsWithOffsets(stopsWithMeta: any[]): any[] {
  const groups: any[][] = [];

  stopsWithMeta.forEach(item => {
    const d = item.destination;
    if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lng)) {
      item.renderLat = d ? d.lat : null;
      item.renderLng = d ? d.lng : null;
      item.isDisplaced = false;
      item.sharedGroup = [];
      return;
    }

    let targetGroup: any[] | null = null;
    for (const g of groups) {
      const rep = g[0].destination;
      const distLat = Math.abs(rep.lat - d.lat);
      const distLng = Math.abs(rep.lng - d.lng);
      const sameAddr = (
        normText(rep.direccion || '') === normText(d.direccion || '') &&
        normText(rep.ciudad || '') === normText(d.ciudad || '') &&
        normText(rep.direccion || '').length > 0
      );
      if (sameAddr || (distLat < 0.00015 && distLng < 0.00015)) {
        targetGroup = g;
        break;
      }
    }

    if (!targetGroup) {
      targetGroup = [];
      groups.push(targetGroup);
    }
    targetGroup.push(item);
  });

  groups.forEach(g => {
    const count = g.length;
    if (count === 1) {
      const it = g[0];
      it.renderLat = it.destination.lat;
      it.renderLng = it.destination.lng;
      it.isDisplaced = false;
      it.sharedGroup = [];
    } else {
      g.forEach((it, k) => {
        const d = it.destination;
        it.isDisplaced = true;
        it.sharedGroup = g.filter(other => other !== it);

        let dLat = 0;
        let dLng = 0;

        if (count === 2) {
          if (k === 0) {
            dLat = -0.00014;
            dLng = -0.00028;
          } else {
            dLat = +0.00014;
            dLng = +0.00028;
          }
        } else if (count === 3) {
          if (k === 0) {
            dLat = -0.00016;
            dLng = -0.00030;
          } else if (k === 1) {
            dLat = +0.00020;
            dLng = 0;
          } else {
            dLat = -0.00016;
            dLng = +0.00030;
          }
        } else {
          const angle = (k * 2 * Math.PI) / count - Math.PI / 2;
          dLat = 0.00022 * Math.sin(angle);
          dLng = 0.00032 * Math.cos(angle);
        }

        it.renderLat = d.lat + dLat;
        it.renderLng = d.lng + dLng;
      });
    }
  });

  return stopsWithMeta;
}

export function renderStopPopupHtml(
  d: any,
  stopIndex: number,
  isLast: boolean,
  returnDep: boolean,
  routeId: number | null = null,
  routeColor: string | null = null,
  sharedGroup: any[] | null = null
): string {
  const isMulti = d.isMultiDelivery && d.entregas && d.entregas.length > 1;
  const numEntregas = isMulti ? d.entregas.length : 1;

  let multiHtml = '';
  if (isMulti) {
    multiHtml = `
      <div class="mt-2 pt-1.5 border-t border-slate-200 dark:border-slate-700">
        <div class="text-[11px] font-bold text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-1">
          🏢 Entregas en este edificio/conjunto (${numEntregas}):
        </div>
        <div class="max-h-36 overflow-y-auto space-y-1 pr-1">
          ${d.entregas.map((e: any, idx: number) => `
            <div class="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-700/60 border border-slate-200/60 dark:border-slate-600 text-[11px]">
              <div class="font-bold text-slate-800 dark:text-slate-100 flex justify-between items-center">
                <span>${idx + 1}. ${esc(e.cliente)}</span>
                <span class="text-emerald-600 dark:text-emerald-400 font-mono font-bold">${e.vol.toFixed(2)} m³</span>
              </div>
              ${e.complemento ? `<div class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">🏢 ${esc(e.complemento)}</div>` : ''}
              <div class="text-[10px] text-slate-500 dark:text-slate-400">📦 Pedido: ${esc(e.pedido)}${e.cedula ? ` · CC: ${esc(e.cedula)}` : ''}</div>
              ${e.telefono ? `<div class="text-[10px] text-slate-500 dark:text-slate-400">📞 ${esc(e.telefono)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  let sharedHtml = '';
  if (sharedGroup && sharedGroup.length > 0) {
    sharedHtml = `
      <div class="mt-2 pt-1.5 border-t border-amber-200 dark:border-amber-700/60">
        <div class="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700/60 text-amber-900 dark:text-amber-200 text-[11px] leading-tight">
          <div class="font-bold flex items-center gap-1 mb-1 text-amber-800 dark:text-amber-300">
            📍 Misma dirección física compartida (${sharedGroup.length + 1} paradas aquí):
          </div>
          <div class="space-y-1">
            ${sharedGroup.map((other: any) => `
              <div class="flex items-center justify-between text-[10px] bg-white/70 dark:bg-slate-800/70 p-1 rounded border border-amber-200/50 dark:border-amber-700/40">
                <span>
                  <b>${other.routeId !== null && other.routeId !== routeId ? `Ruta ${other.routeId + 1} · ` : ''}Parada #${other.stopIndex + 1}:</b> 
                  ${esc(other.destination.cliente)}
                </span>
                <span class="font-mono text-emerald-700 dark:text-emerald-400 font-bold ml-1">${other.destination.vol.toFixed(2)} m³</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="text-xs space-y-1 min-w-[210px] max-w-[280px]">
      ${routeId !== null ? `
        <div class="flex items-center gap-1.5 pb-1 border-b border-slate-200 dark:border-slate-700">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${routeColor}"></span>
          <b class="text-xs text-slate-900 dark:text-white">Ruta ${routeId + 1}</b>
        </div>
      ` : ''}
      <div class="flex items-center gap-1 flex-wrap">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isLast && !returnDep ? 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200' : 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-200'}">Parada ${stopIndex + 1}${isLast && !returnDep ? ' · Fin de ruta' : ''}</span>
        ${isMulti ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">🏢 ${numEntregas} entregas</span>` : ''}
        ${sharedGroup && sharedGroup.length > 0 ? `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-400/40">📍 Misma dir.</span>` : ''}
      </div>
      <strong class="text-sm block text-slate-900 dark:text-white">${esc(isMulti ? d.clienteDisplay : d.cliente)}</strong>
      <div class="text-slate-600 dark:text-slate-300">📍 ${esc(d.direccion)} (${esc(d.ciudad)})</div>
      ${d.barrio ? `<div class="text-slate-500 dark:text-slate-400">🏘️ Barrio: <b>${esc(d.barrio)}</b></div>` : ''}
      ${!isMulti ? `
        <div class="text-slate-500 dark:text-slate-400">📦 Pedidos: ${esc(d.pedidos.join(', '))}</div>
      ` : ''}
      <div class="font-bold text-slate-800 dark:text-slate-200">⚖️ Volumen total: <b>${d.vol.toFixed(2)} m³</b></div>
      ${sharedHtml}
      ${multiHtml}
      <div class="pt-2 flex gap-1.5 flex-wrap">
        <button type="button" onclick="window.openReassignModal(${d.id}, ${routeId !== null ? routeId : -1})" class="px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[11px] font-semibold flex items-center gap-1 shadow-xs cursor-pointer" title="Reasignar o mover esta parada a otra ruta">
          ⇄ Reasignar Ruta
        </button>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&travelmode=driving&dir_action=navigate" target="_blank" rel="noopener noreferrer" class="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-semibold flex items-center gap-1 shadow-xs" title="Abrir navegación GPS paso a paso">
          🧭 Navegar GPS
        </a>
        <button type="button" onclick="window.openEditLocationModal(${d.id})" class="px-2 py-1 bg-brand-500 hover:bg-brand-600 text-white rounded text-[11px] font-semibold flex items-center gap-1 shadow-xs">
          ✏️ Corregir
        </button>
        <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.direccion}, ${d.ciudad}, Colombia`)}" target="_blank" rel="noopener noreferrer" class="px-2 py-1 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 rounded text-[11px] font-medium border border-slate-300 dark:border-slate-600 flex items-center gap-1">
          Google Maps
        </a>
      </div>
    </div>
  `;
}

export async function draw(r: any, { preserveView = false } = {}): Promise<void> {
  S.currentRouteIndex = r.id;
  S.viewMode = 'single';
  const label = document.getElementById('activeRouteLabel');
  if (label) label.textContent = `Ruta ${r.id + 1}`;

  const allBtn = document.getElementById('btnViewAllRoutes');
  if (allBtn) {
    allBtn.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600 shadow-2xs transition cursor-pointer';
  }
  const mapBarBtn = document.getElementById('btnViewAllRoutesMapBar');
  if (mapBarBtn) {
    mapBarBtn.className = 'py-1 px-3 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 text-[11px] font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 shadow-2xs transition cursor-pointer whitespace-nowrap';
  }

  const st = active(r);
  if (!st || !st.length || !S.map) return;

  const returnDep = isReturnDepot();
  const allStops = [DEPOT, ...st];
  if (returnDep) allStops.push(DEPOT);

  if (S.routeLayer) S.routeLayer.clearLayers();
  if (S.markers) S.markers.clearLayers();
  S.stopMarkers = [];

  L.marker([DEPOT.lat, DEPOT.lng], {
    icon: L.divIcon({
      html: `<div style="background:#0f172a;color:#38bdf8;border-radius:8px;padding:3px 7px;font-size:11px;font-weight:bold;border:2px solid #38bdf8;box-shadow:0 3px 6px rgba(0,0,0,0.35);display:flex;align-items:center;gap:3px;white-space:nowrap">🏢 Cendis Siberia</div>`,
      className: '',
      iconSize: [110, 26],
      iconAnchor: [55, 13]
    })
  }).bindPopup(`
    <div class="text-xs space-y-1">
      <strong class="text-sm">🏢 Cendis Jamar Siberia</strong><br>
      📍 Lat: 4.7623889, Lng: -74.1616574<br>
      <span class="text-slate-500">Punto de salida oficial para todas las rutas.</span>
    </div>
  `).addTo(S.markers);

  const isPines = S.routeViewStyle === 'pines';

  const stopsMeta = st.map((d: any, i: number) => ({
    destination: d,
    stopIndex: i,
    routeId: r.id,
    routeColor: r.color,
    isLast: i === st.length - 1
  }));
  const stopsWithOffsets = computeStopsWithOffsets(stopsMeta);

  stopsWithOffsets.forEach((it: any) => {
    const d = it.destination;
    const i = it.stopIndex;
    const isLast = it.isLast;

    if (it.isDisplaced) {
      L.polyline([[d.lat, d.lng], [it.renderLat, it.renderLng]], {
        color: r.color,
        weight: 2,
        dashArray: '3, 4',
        opacity: 0.7
      }).addTo(S.markers);

      L.circleMarker([d.lat, d.lng], {
        radius: 3.5,
        fillColor: r.color,
        fillOpacity: 0.85,
        color: '#ffffff',
        weight: 1.5
      }).addTo(S.markers);
    }

    const m = L.marker([it.renderLat, it.renderLng], {
      icon: getStopMarkerIcon(r.color, i, isPines, r.id, S.pinSize)
    });
    m._stopData = {
      routeColor: r.color,
      stopIndex: i,
      isSingleRoute: true,
      routeId: r.id,
      destination: d,
      isDisplaced: it.isDisplaced
    };
    S.stopMarkers.push(m);

    const barrioTexto = d.barrio ? d.barrio : d.ciudad;
    const isMulti = d.isMultiDelivery && d.entregas && d.entregas.length > 1;
    const multiTag = isMulti ? ` (${d.entregas.length} ent.)` : '';
    const sharedTag = it.isDisplaced && it.sharedGroup && it.sharedGroup.length
      ? ` · (Misma dirección #${it.sharedGroup.map((o: any) => o.stopIndex + 1).join(', #')})`
      : '';
    const clientInfo = d.destinatario ? `<br><span style="opacity:0.88;font-weight:normal">👤 ${esc(d.destinatario)}</span>` : '';

    const isMicro = S.pinSize === 'micro';
    const tooltipOffset = isMicro ? [0, -24] : (isPines ? [0, -36] : [0, -14]);

    m.bindTooltip(`<b>R${r.id + 1} · #${i + 1}</b>${multiTag}${sharedTag} ${esc(barrioTexto)}${clientInfo}`, {
      permanent: false,
      direction: 'top',
      offset: tooltipOffset,
      className: 'stop-badge-label'
    });

    m.bindPopup(renderStopPopupHtml(d, i, isLast, returnDep, r.id, r.color, it.sharedGroup)).addTo(S.markers);
  });

  if (!preserveView) {
    const bounds = L.latLngBounds([[DEPOT.lat, DEPOT.lng], ...st.map((x: any) => [x.lat, x.lng])]);
    if (bounds.isValid()) {
      S.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    }
  }

  const cacheKey = `${r.option}_${returnDep ? 'ret' : 'noret'}_${st.map((x: any) => `${x.id}_${(x.lat || 0).toFixed(4)}_${(x.lng || 0).toFixed(4)}`).join('-')}`;
  r._osrmCache = r._osrmCache || {};

  const applyRouteLayerVisibility = () => {
    if (!S.map || !S.routeLayer) return;
    if (S.routeViewStyle === 'pines') {
      if (S.map.hasLayer(S.routeLayer)) S.map.removeLayer(S.routeLayer);
    } else {
      if (!S.map.hasLayer(S.routeLayer)) S.map.addLayer(S.routeLayer);
    }
  };

  if (r._osrmCache[cacheKey]) {
    const cached = r._osrmCache[cacheKey];
    const ll = Array.isArray(cached) ? cached : cached.coordinates;
    if (cached && cached.distanceKm) {
      applyRealDistanceToRoute(r, cached.distanceKm, cached.durationMin);
    }
    L.polyline(ll, { color: r.color, weight: 5, opacity: 0.9 }).addTo(S.routeLayer);
    if (!preserveView) S.map.fitBounds(L.latLngBounds(ll), { padding: [35, 35] });
    applyRouteLayerVisibility();
    return;
  }

  try {
    const pts = allStops.map((x: any) => `${x.lng},${x.lat}`).join(';');
    const res = await fetch(OSRM_URL + pts + '?overview=full&geometries=geojson');
    const j = await res.json();
    if (j.routes && j.routes[0]) {
      const ll = j.routes[0].geometry.coordinates.map((x: any) => [x[1], x[0]]);
      const distanceKm = Math.round((j.routes[0].distance / 1000) * 10) / 10;
      const durationMin = Math.round(j.routes[0].duration / 60);
      r._osrmCache[cacheKey] = { coordinates: ll, distanceKm, durationMin };
      applyRealDistanceToRoute(r, distanceKm, durationMin);
      L.polyline(ll, { color: r.color, weight: 5, opacity: 0.9 }).addTo(S.routeLayer);
      if (!preserveView) S.map.fitBounds(L.latLngBounds(ll), { padding: [35, 35] });
      applyRouteLayerVisibility();
      return;
    }
    throw new Error('OSRM no routes');
  } catch (e) {
    const ll = allStops.map((x: any) => [x.lat, x.lng]);
    L.polyline(ll, { color: r.color, weight: 4, dashArray: '6,6' }).addTo(S.routeLayer);
    if (!preserveView) S.map.fitBounds(L.latLngBounds(ll), { padding: [35, 35] });
    applyRouteLayerVisibility();
  } finally {
    applyRouteLayerVisibility();
    setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 250);
  }
}

export async function drawAllRoutes({ preserveView = false } = {}): Promise<void> {
  S.viewMode = 'all';
  S.currentRouteIndex = -1;
  const label = document.getElementById('activeRouteLabel');
  if (label) label.textContent = 'Todas las Rutas';

  const allBtn = document.getElementById('btnViewAllRoutes');
  if (allBtn) {
    allBtn.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-[#EA580C] text-white shadow-xs transition cursor-pointer';
  }
  const mapBarBtn = document.getElementById('btnViewAllRoutesMapBar');
  if (mapBarBtn) {
    mapBarBtn.className = 'py-1 px-3 rounded-full bg-[#EA580C] text-white text-[11px] font-bold inline-flex items-center gap-1.5 shadow-xs transition cursor-pointer whitespace-nowrap';
  }

  document.querySelectorAll('.route-card').forEach(c => {
    c.classList.remove('border-brand-500', 'ring-2', 'ring-brand-500/20', 'active-fleetlog-card');
    c.classList.add('border-slate-200', 'dark:border-slate-700');
  });

  if (!S.map) return;

  const returnDep = isReturnDepot();
  const visibleRoutes = (S.routes || []).filter(r => r.visible !== false);

  S.routeLayer.clearLayers();
  S.markers.clearLayers();
  S.stopMarkers = [];

  if (!visibleRoutes.length) {
    toast('No hay rutas marcadas para mostrar en el mapa', 'warn');
    return;
  }

  L.marker([DEPOT.lat, DEPOT.lng], {
    icon: L.divIcon({
      html: `<div style="background:#0f172a;color:#38bdf8;border-radius:8px;padding:3px 7px;font-size:11px;font-weight:bold;border:2px solid #38bdf8;box-shadow:0 3px 6px rgba(0,0,0,0.35);display:flex;align-items:center;gap:3px;white-space:nowrap">🏢 Cendis Siberia</div>`,
      className: '',
      iconSize: [110, 26],
      iconAnchor: [55, 13]
    })
  }).bindPopup(`
    <div class="text-xs space-y-1">
      <strong class="text-sm">🏢 Cendis Jamar Siberia</strong><br>
      📍 Lat: 4.7623889, Lng: -74.1616574<br>
      <span class="text-slate-500">Punto de salida oficial para todas las rutas.</span>
    </div>
  `).addTo(S.markers);

  const allCoords: [number, number][] = [[DEPOT.lat, DEPOT.lng]];
  const isPines = S.routeViewStyle === 'pines';

  const allStopsMeta: any[] = [];
  visibleRoutes.forEach(r => {
    const st = active(r);
    st.forEach((d: any, i: number) => {
      allCoords.push([d.lat, d.lng]);
      allStopsMeta.push({
        destination: d,
        stopIndex: i,
        routeId: r.id,
        routeColor: r.color,
        isLast: i === st.length - 1
      });
    });
  });

  const stopsWithOffsets = computeStopsWithOffsets(allStopsMeta);

  stopsWithOffsets.forEach((it: any) => {
    const d = it.destination;
    const i = it.stopIndex;
    const isLast = it.isLast;
    const rId = it.routeId;
    const rColor = it.routeColor;

    if (it.isDisplaced) {
      L.polyline([[d.lat, d.lng], [it.renderLat, it.renderLng]], {
        color: rColor,
        weight: 2,
        dashArray: '3, 4',
        opacity: 0.7
      }).addTo(S.markers);

      L.circleMarker([d.lat, d.lng], {
        radius: 3.5,
        fillColor: rColor,
        fillOpacity: 0.85,
        color: '#ffffff',
        weight: 1.5
      }).addTo(S.markers);
    }

    const m = L.marker([it.renderLat, it.renderLng], {
      icon: getStopMarkerIcon(rColor, i, isPines, rId, S.pinSize)
    });
    m._stopData = {
      routeColor: rColor,
      stopIndex: i,
      isSingleRoute: false,
      routeId: rId,
      destination: d,
      isDisplaced: it.isDisplaced
    };
    S.stopMarkers.push(m);

    const barrioTexto = d.barrio ? d.barrio : d.ciudad;
    const isMulti = d.isMultiDelivery && d.entregas && d.entregas.length > 1;
    const multiTag = isMulti ? ` (${d.entregas.length} ent.)` : '';
    const sharedTag = it.isDisplaced && it.sharedGroup && it.sharedGroup.length
      ? ` · (Misma dir. #${it.sharedGroup.map((o: any) => (o.routeId !== rId ? `R${o.routeId + 1}-#${o.stopIndex + 1}` : `#${o.stopIndex + 1}`)).join(', ')})`
      : '';
    const clientInfo = d.destinatario ? `<br><span style="opacity:0.88;font-weight:normal">👤 ${esc(d.destinatario)}</span>` : '';

    const isMicro = S.pinSize === 'micro';
    const tooltipOffset = isMicro ? [0, -24] : (isPines ? [0, -36] : [0, -14]);

    m.bindTooltip(`<b>Ruta ${rId + 1} · #${i + 1}</b>${multiTag}${sharedTag} ${esc(barrioTexto)}${clientInfo}`, {
      permanent: false,
      direction: 'top',
      offset: tooltipOffset,
      className: 'stop-badge-label'
    });

    m.bindPopup(renderStopPopupHtml(d, i, isLast, returnDep, rId, rColor, it.sharedGroup)).addTo(S.markers);
  });

  if (!preserveView && allCoords.length > 1) {
    const bounds = L.latLngBounds(allCoords);
    if (bounds.isValid()) {
      S.map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  await Promise.all(visibleRoutes.map(async (r: any) => {
    const st = active(r);
    if (!st || !st.length) return;
    const allStops = [DEPOT, ...st];
    if (returnDep) allStops.push(DEPOT);

    const cacheKey = `${r.option}_${returnDep ? 'ret' : 'noret'}_${st.map((x: any) => `${x.id}_${(x.lat || 0).toFixed(4)}_${(x.lng || 0).toFixed(4)}`).join('-')}`;
    r._osrmCache = r._osrmCache || {};

    if (r._osrmCache[cacheKey]) {
      const cached = r._osrmCache[cacheKey];
      const ll = Array.isArray(cached) ? cached : cached.coordinates;
      if (cached && cached.distanceKm) {
        applyRealDistanceToRoute(r, cached.distanceKm, cached.durationMin);
      }
      L.polyline(ll, { color: r.color, weight: 4.5, opacity: 0.85 }).addTo(S.routeLayer);
      return;
    }

    try {
      const pts = allStops.map((x: any) => `${x.lng},${x.lat}`).join(';');
      const res = await fetch(OSRM_URL + pts + '?overview=full&geometries=geojson');
      const j = await res.json();
      if (j.routes && j.routes[0]) {
        const ll = j.routes[0].geometry.coordinates.map((x: any) => [x[1], x[0]]);
        const distanceKm = Math.round((j.routes[0].distance / 1000) * 10) / 10;
        const durationMin = Math.round(j.routes[0].duration / 60);
        r._osrmCache[cacheKey] = { coordinates: ll, distanceKm, durationMin };
        applyRealDistanceToRoute(r, distanceKm, durationMin);
        L.polyline(ll, { color: r.color, weight: 4.5, opacity: 0.85 }).addTo(S.routeLayer);
        return;
      }
      throw new Error('OSRM error');
    } catch (e) {
      const ll = allStops.map((x: any) => [x.lat, x.lng]);
      L.polyline(ll, { color: r.color, weight: 3.5, dashArray: '6,6', opacity: 0.75 }).addTo(S.routeLayer);
    }
  }));

  if (S.map && S.routeLayer) {
    if (S.routeViewStyle === 'pines') {
      if (S.map.hasLayer(S.routeLayer)) S.map.removeLayer(S.routeLayer);
    } else {
      if (!S.map.hasLayer(S.routeLayer)) S.map.addLayer(S.routeLayer);
    }
  }

  setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 250);
}

export function initMap(): void {
  if (!S.map) {
    S.map = L.map('map', {
      preferCanvas: true,
      center: [DEPOT.lat, DEPOT.lng],
      zoom: 11,
      zoomControl: true,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 120,
      wheelDebounceTime: 40,
      zoomAnimation: true,
      zoomAnimationThreshold: 4
    });

    switchMapTile('roadmap');

    S.routeLayer = L.layerGroup().addTo(S.map);
    S.markers = L.layerGroup().addTo(S.map);

    L.marker([DEPOT.lat, DEPOT.lng], {
      icon: L.divIcon({
        html: `<div style="background:#0f172a;color:#38bdf8;border-radius:8px;padding:3px 7px;font-size:11px;font-weight:bold;border:2px solid #38bdf8;box-shadow:0 3px 6px rgba(0,0,0,0.35);display:flex;align-items:center;gap:3px;white-space:nowrap">🏢 Cendis Siberia</div>`,
        className: 'depot-pin',
        iconSize: [110, 26],
        iconAnchor: [55, 13]
      })
    }).addTo(S.markers).bindPopup('<b>Cendis Jamar Siberia</b><br>Salida fija de todas las rutas');

    const btnPinMicro = document.getElementById('btnPinSizeMicro');
    if (btnPinMicro) btnPinMicro.onclick = () => setPinSizeMode('micro');
    const btnPinStd = document.getElementById('btnPinSizeStandard');
    if (btnPinStd) btnPinStd.onclick = () => setPinSizeMode('estandar');
    updatePinSizeModeUI(S.pinSize || 'micro');

    const btnViewFull = document.getElementById('btnViewStyleFull');
    if (btnViewFull) btnViewFull.onclick = () => setRouteViewStyle('completo');
    const btnViewPins = document.getElementById('btnViewStylePins');
    if (btnViewPins) btnViewPins.onclick = () => setRouteViewStyle('pines');

    const btnRoadmap = document.getElementById('btnLayerRoadmap');
    if (btnRoadmap) btnRoadmap.onclick = () => switchMapTile('roadmap');
    const btnSatellite = document.getElementById('btnLayerSatellite');
    if (btnSatellite) btnSatellite.onclick = () => switchMapTile('satellite');

    const triggerViewAll = () => {
      const anyChecked = (S.routes || []).some(r => r.visible !== false);
      if (!anyChecked) {
        (S.routes || []).forEach(r => { r.visible = true; });
        if ((window as any).renderRoutes) (window as any).renderRoutes();
      }
      drawAllRoutes();
    };

    const btnViewAll = document.getElementById('btnViewAllRoutes');
    if (btnViewAll) btnViewAll.onclick = triggerViewAll;

    const btnViewAllMap = document.getElementById('btnViewAllRoutesMapBar');
    if (btnViewAllMap) btnViewAllMap.onclick = triggerViewAll;

    if (window.ResizeObserver) {
      const wrap = document.getElementById('mapWrap');
      if (wrap) {
        new ResizeObserver(() => {
          if (S.map) S.map.invalidateSize();
        }).observe(wrap);
      }
    }
  }

  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
    if ((window as any).renderTelemetryOnMap) (window as any).renderTelemetryOnMap();
  }, 200);
}

if (typeof window !== 'undefined') {
  (window as any).draw = draw;
  (window as any).drawAllRoutes = drawAllRoutes;
  (window as any).initMap = initMap;
  (window as any).switchMapTile = switchMapTile;
  (window as any).setPinSizeMode = setPinSizeMode;
  (window as any).setRouteViewStyle = setRouteViewStyle;
}
