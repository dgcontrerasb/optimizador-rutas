import { S, toast, safeGet, safeSet, esc } from './state/store';
import { classifyZone } from './config/zones';
import {
  cacheKey,
  clearGeoCache,
  geocodeWithGoogle,
  sleep
} from './services/geocoding';
import {
  extractSheetData,
  findColSmart,
  generateCorrectedRows,
  preprocess,
  showColumnMappingModal,
  CM_DEFAULTS
} from './services/excel';
import {
  active,
  alternatives,
  buildGroups
} from './services/routing';
import { syncAllRoutesRealDistance } from './services/osrm';
import {
  draw,
  initMap,
  setPinSizeMode,
  setRouteViewStyle,
  updatePinSizeModeUI,
  updateRouteViewStyleUI
} from './map/leafletMap';
import { downloadMapAsPng } from './map/mapExport';
import {
  initClientSearchListeners,
  openReassignModal,
  renderRoutes,
  replanRoutes
} from './ui/routeCards';
import {
  closeEditLocationModal,
  initEditModalListeners,
  openEditLocationModal,
  renderAlerts
} from './ui/editModal';
import {
  initToolbarListeners,
  updateDistModeUI
} from './ui/toolbar';
import { initAuthGate } from './ui/authGate';
import { withJamarLoader } from './ui/loader';
import {
  clearAllTelemetryTrucks,
  initTelemetrySystem,
  publishRoutesToTelemetryServer,
  renderTelemetryOnMap,
  renderTelemetryPanelUI
} from './services/telemetry';
import {
  clearAllPolygons,
  renderPolygonsOnMap,
  renderPolygonToolbarUI,
  renderUnassignedPinsOnMap
} from './services/polygonGeofence';

declare const XLSX: any;

const PRE_GEO: Record<string, { lat: number; lng: number }> = {
  MADRID: { lat: 4.7331, lng: -74.2642 },
  MOSQUERA: { lat: 4.7059, lng: -74.2302 },
  SOACHA: { lat: 4.5802, lng: -74.2166 },
  FUNZA: { lat: 4.7164, lng: -74.2119 },
  FACATATIVA: { lat: 4.8142, lng: -74.3541 },
  CHIA: { lat: 4.8631, lng: -74.0587 },
  COTA: { lat: 4.8122, lng: -74.1028 },
  CAJICA: { lat: 4.9194, lng: -74.0275 },
  TENJO: { lat: 4.8728, lng: -74.1436 },
  TABIO: { lat: 4.9189, lng: -74.0989 },
  SOPO: { lat: 4.9083, lng: -73.9406 },
  TOCANCIPA: { lat: 4.9667, lng: -73.9167 },
  GACHANCIPA: { lat: 4.9917, lng: -73.8722 },
  'LA CALERA': { lat: 4.7203, lng: -73.9708 },
  SIBATE: { lat: 4.4922, lng: -74.2608 },
  'EL ROSAL': { lat: 4.8528, lng: -74.2611 },
  BOGOTA: { lat: 4.6500, lng: -74.1000 }
};

export async function geocodeOne(d: any): Promise<any> {
  const k = cacheKey(d);
  const saved = safeGet(k);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      const isBogota = ((d.ciudad || 'BOGOTA').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase()).includes('BOGOTA');
      if (isBogota && parsed.lat > 4.90) {
        try { localStorage.removeItem(k); } catch (e) {}
      } else if (parsed.strategy !== 'Aproximación por cuadrante urbano' && parsed.lat && parsed.lng) {
        return { ...parsed, confidence: 'Recuperada de caché', strategy: 'Caché local' };
      }
    } catch (e) {}
  }

  try {
    const gResult = await geocodeWithGoogle(d.direccion, d.ciudad);
    if (gResult && Number.isFinite(gResult.lat) && Number.isFinite(gResult.lng)) {
      safeSet(k, JSON.stringify(gResult));
      return gResult;
    }
  } catch (err) {
    console.warn('Error en geocodificación con Google Maps:', err);
  }

  return null;
}

export async function geocodeAll(onlyAlerts = false): Promise<void> {
  const list = onlyAlerts ? S.alerts : S.destinations;
  if (!list || !list.length) return;

  const progSec = document.getElementById('progressSec');
  if (progSec) progSec.classList.remove('hidden');
  const progTotal = document.getElementById('progressTotal');
  if (progTotal) progTotal.textContent = String(list.length);
  S.alerts = [];

  for (let i = 0; i < list.length; i++) {
    const d: any = list[i];
    try {
      await sleep(120);
      let r = await geocodeOne(d);

      const c = (d.ciudad || 'BOGOTA').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
      const isBogota = c === 'BOGOTA' || c.includes('BOGOTA') || !c;
      if (r && isBogota && r.lat > 4.90) {
        try {
          localStorage.removeItem(cacheKey(d));
        } catch (e) {}

        const cleanGoogleRes = await geocodeWithGoogle(d.direccion, 'BOGOTA');
        if (cleanGoogleRes && Number.isFinite(cleanGoogleRes.lat) && cleanGoogleRes.lat <= 4.90) {
          r = cleanGoogleRes;
          safeSet(cacheKey(d), JSON.stringify(r));
        } else {
          r = null;
        }
      }

      if (r) {
        d.lat = r.lat;
        d.lng = r.lng;
        d.geocoded = true;
        d.confidence = r.confidence;
        d.strategy = r.strategy;
        d.display = r.display || d.direccion;
      } else {
        d.geocoded = false;
        d.confidence = 'No encontrada';
        d.strategy = 'Sin resultado';
        S.alerts.push(d);
      }
    } catch (eOne) {
      d.geocoded = false;
      d.confidence = 'Error al consultar';
      d.strategy = 'Sin resultado';
      S.alerts.push(d);
    }

    const progNow = document.getElementById('progressNow');
    if (progNow) progNow.textContent = String(i + 1);
    const progBar = document.getElementById('progressBar');
    if (progBar) progBar.style.width = ((i + 1) / list.length * 100) + '%';
  }

  if (progSec) progSec.classList.add('hidden');
  const statAlDiv = document.querySelector('#statAl div');
  if (statAlDiv) statAlDiv.textContent = String(S.alerts.length);

  const validGeocoded = S.destinations.filter(d => d.lat && d.lng);
  if (validGeocoded.length > 0) {
    generate();
  }

  const alertsEl = document.getElementById('alertsSec');
  if (S.alerts.length) {
    renderAlerts();
    if (alertsEl) alertsEl.classList.remove('hidden');
    if (validGeocoded.length > 0) {
      toast(`Rutas creadas (${validGeocoded.length} destinos). Hay ${S.alerts.length} pendientes de verificación manual.`, 'warn');
    } else {
      toast(`${S.alerts.length} destinos pendientes para verificación manual.`, 'warn');
    }
  } else {
    if (alertsEl) alertsEl.classList.add('hidden');
  }
}

export function generate(): Promise<void> | void {
  return withJamarLoader(() => {
    S.routes = buildGroups().map((stops, i) => {
      const x = alternatives(stops);
      return {
        id: i,
        color: S.colors[i % S.colors.length],
        stops,
        alts: {
          A: { stops: x.a, km: x.da, vol: stops.reduce((acc, s) => acc + s.vol, 0) },
          B: { stops: x.b, km: x.db, vol: stops.reduce((acc, s) => acc + s.vol, 0) },
          ...x
        } as any,
        option: x.chosen,
        visible: true
      };
    });

    S.viewMode = 'single';
    renderRoutes();
    const resultsSec = document.getElementById('resultsSec');
    if (resultsSec) resultsSec.classList.remove('hidden');
    initMap();

    if (S.routes[0]) {
      S.currentRouteIndex = 0;
      draw(S.routes[0]);
    }
    syncAllRoutesRealDistance();
    publishRoutesToTelemetryServer();
    renderTelemetryPanelUI();
    renderTelemetryOnMap();
    renderPolygonsOnMap();
    renderUnassignedPinsOnMap();
    renderPolygonToolbarUI();
    // Colapsar inteligentemente el primer panel oscuro para dar máximo espacio al mapa y las rutas
    toggleDarkSidebar(true);
    toast(`${S.routes.length} rutas zonificadas y optimizadas con éxito`, 'success');
  }, 'OPTIMIZANDO', 'Zonificando flota y trazando rutas en Cendis Siberia...', 1400);
}

export async function processRowsWithMapping(rows: any[], headers: string[], cm: any): Promise<void> {
  const welcomeArea = document.getElementById('welcomeUploadArea');
  if (!cm.addr) {
    toast('No se definió la columna de Dirección.', 'error');
    return;
  }

  const p = preprocess(rows, cm);
  if (!p.destinations || !p.destinations.length) {
    throw new Error('No se encontraron destinos válidos para planificar. Verifica que las filas contengan direcciones y no pertenezcan exclusivamente a zonas fuera de cobertura.');
  }

  if (welcomeArea) welcomeArea.classList.add('hidden');

  S.destinations = p.destinations;
  S.rawRows = rows;
  (S as any).rawHeaders = headers;
  (S as any).cm = cm;
  S.orders = p.orders;
  S.stats = p.stats;
  (S as any).excludedRows = p.excludedRows;

  const statDestEl = document.querySelector('#statDest div');
  if (statDestEl) statDestEl.textContent = String(p.destinations.length);
  const statPedEl = document.querySelector('#statPedidos div');
  if (statPedEl) statPedEl.textContent = String(p.stats.orders);
  const statExEl = document.querySelector('#statEx div');
  if (statExEl) statExEl.textContent = String(p.stats.cityExcluded + p.stats.freightExcluded);

  toast(`${p.destinations.length} destinos físicos consolidados correctamente`, 'success');
  showSummary(p.stats);
  await geocodeAll();
}

export function showSummary(x: any): void {
  const summaryEl = document.getElementById('summary');
  if (!summaryEl || !x) return;
  const city = Object.entries(x.cities || {}).map(([k, v]) => `<li>${esc(k)}: ${v} filas</li>`).join('');
  const cor = Object.entries(x.corrected || {}).map(([k, v]) => `<li>${esc(k)} → FUNZA: ${v} filas</li>`).join('');
  summaryEl.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-700/50 border border-slate-200/80 dark:border-slate-600 space-y-1">
        <p class="font-semibold text-slate-800 dark:text-slate-100">📥 Filas leídas: <span class="font-bold text-blue-600 dark:text-blue-400">${x.rows || 0}</span></p>
        <p class="text-slate-600 dark:text-slate-300">🚫 Excluidas por ciudad: <b>${x.cityExcluded || 0}</b></p>
        ${city ? `<ul class="list-disc list-inside text-xs text-slate-500 pl-2 mt-1">${city}</ul>` : ''}
        <p class="text-slate-600 dark:text-slate-300">🚫 Excluidas por flete o volumen cero: <b>${x.freightExcluded || 0}</b></p>
        ${x.cendisExcluded ? `<p class="text-amber-700 dark:text-amber-400 font-semibold">🏢 Excluidas por Cendis Bogotá: <b>${x.cendisExcluded}</b></p>` : ''}
      </div>
      <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-700/50 border border-slate-200/80 dark:border-slate-600 space-y-1">
        <p class="font-semibold text-slate-800 dark:text-slate-100">📦 Pedidos únicos consolidados: <span class="font-bold text-emerald-600 dark:text-emerald-400">${x.orders || 0}</span></p>
        <p class="font-semibold text-slate-800 dark:text-slate-100">📍 Destinos físicos consolidados: <span class="font-bold text-blue-600 dark:text-blue-400">${x.destinations || 0}</span></p>
        ${x.branchHomologated ? `<p class="text-emerald-700 dark:text-emerald-400 font-semibold">🏬 Tiendas Jamar homologadas: <b>${x.branchHomologated}</b></p>` : ''}
        ${cor ? `<div class="mt-1 text-xs text-blue-600 dark:text-blue-400 font-medium">Corrección automática:<ul>${cor}</ul></div>` : ''}
      </div>
    </div>
    <div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-3">
      <span class="text-xs text-slate-500 dark:text-slate-400">¿Deseas descargar el archivo original con las direcciones normalizadas?</span>
      <div class="flex items-center gap-2">
        <button id="reopenColMapBtn" type="button" class="px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold shadow-2xs transition inline-flex items-center gap-1.5 cursor-pointer">
          <span>📋</span>
          <span>Mapeo de Columnas</span>
        </button>
        <button id="downloadExcelFromSummaryBtn" type="button" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition inline-flex items-center gap-1.5 cursor-pointer">
          <span>📥</span>
          <span>Descargar Excel con Direcciones Corregidas (.xlsx)</span>
        </button>
      </div>
    </div>
  `;

  const reopenBtn = document.getElementById('reopenColMapBtn');
  if (reopenBtn) {
    reopenBtn.onclick = () => {
      if (!S.rawRows || !S.rawRows.length) {
        toast('No hay archivo cargado actualmente para mapear', 'warn');
        return;
      }
      const headers = (S as any).rawHeaders && (S as any).rawHeaders.length ? (S as any).rawHeaders : Object.keys(S.rawRows[0] || {});
      showColumnMappingModal(S.rawRows, headers, (S as any).cm || {}, async (newCm) => {
        toast('Reprocesando destinos con el nuevo mapeo de columnas...', 'info');
        await processRowsWithMapping(S.rawRows, headers, newCm);
      });
    };
  }

  const btn = document.getElementById('downloadExcelFromSummaryBtn');
  if (btn) {
    btn.onclick = () => {
      if (!S.rawRows || !S.rawRows.length) return;
      const h = Object.keys(S.rawRows[0] || {});
      const addrCol = ((S as any).cm && (S as any).cm.addr) || findColSmart(h, 'addr', S.rawRows) || 'Dirección';
      const updatedRows = generateCorrectedRows(S.rawRows, addrCol);
      const newWb = XLSX.utils.book_new();
      const newSheet = XLSX.utils.json_to_sheet(updatedRows);
      XLSX.utils.book_append_sheet(newWb, newSheet, 'DESPACHOS');
      XLSX.writeFile(newWb, 'DESPACHOS_Direcciones_Corregidas.xlsx');
      toast('Excel descargado con columna de direcciones corregidas', 'success');
    };
  }
}

export async function handleClearCacheAndRegeocode(): Promise<void> {
  const count = clearGeoCache();
  if (S.destinations && S.destinations.length > 0) {
    toast(`Caché borrada (${count} registros). Rebuscando todas las direcciones desde cero...`, 'info');
    S.destinations.forEach(d => {
      (d as any).geocoded = false;
      d.lat = null;
      d.lng = null;
      d.confidence = '';
      d.strategy = '';
    });
    const resultsSec = document.getElementById('resultsSec');
    if (resultsSec) resultsSec.classList.add('hidden');
    S.routes = [];
    if (S.markers) S.markers.clearLayers();
    if (S.routeLayer) S.routeLayer.clearLayers();
    await geocodeAll(false);
  } else {
    withJamarLoader(() => {
      toast(`Caché borrada (${count} registros). Al subir tu archivo Excel se buscarán todas las direcciones desde cero.`, 'success');
    }, 'MEMORIA', 'Limpiando direcciones en caché local...', 650);
  }
}

// Fast normalize mode
let fastNormalizedWorkbook: any = null;
let fastNormalizedFileName = 'DESPACHOS_Direcciones_Corregidas.xlsx';

async function handleFastNormalize(file: File): Promise<void> {
  if (!file) return;
  try {
    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: 'array' });
    const { rows, headers, sheetName } = extractSheetData(wb);

    if (!rows.length) {
      toast('El archivo Excel seleccionado no contiene filas.', 'error');
      return;
    }

    const h = headers.length ? headers : Object.keys(rows[0] || {});
    const addrCol = findColSmart(h, 'addr', rows) || h.find(k => /direcci[oó]n/i.test(k));

    if (!addrCol) {
      toast('No se encontró la columna de Dirección en el archivo.', 'error');
      return;
    }

    const updatedRows = generateCorrectedRows(rows, addrCol);

    const newWb = XLSX.utils.book_new();
    const newSheet = XLSX.utils.json_to_sheet(updatedRows);
    XLSX.utils.book_append_sheet(newWb, newSheet, sheetName || 'DESPACHOS');

    fastNormalizedWorkbook = newWb;
    fastNormalizedFileName = (file.name || 'despachos').replace(/\.[^/.]+$/, '') + '_Direcciones_Corregidas.xlsx';

    const statsEl = document.getElementById('fastNormalizeStats');
    if (statsEl) {
      statsEl.innerHTML = `
        <p class="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <span class="text-emerald-600 dark:text-emerald-400">✓</span> Procesadas ${updatedRows.length} filas con éxito
        </p>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          Columna detectada: <b>${esc(addrCol)}</b> · Hoja: <b>${esc(sheetName)}</b>
        </p>
      `;
    }

    const previewTbody = document.getElementById('fastNormalizePreviewTable');
    if (previewTbody) {
      const previewRows = updatedRows.slice(0, 6);
      previewTbody.innerHTML = previewRows.map((r, idx) => `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/50">
          <td class="p-2.5 font-mono text-slate-400 text-[11px]">${idx + 1}</td>
          <td class="p-2.5 text-slate-700 dark:text-slate-300 font-mono text-xs">${esc(String(r[addrCol] || ''))}</td>
          <td class="p-2.5 bg-emerald-50/40 dark:bg-emerald-950/20 font-bold text-emerald-700 dark:text-emerald-300 font-mono text-xs">${esc(String(r['Dirección Corregida'] || ''))}</td>
          <td class="p-2.5 text-slate-500 dark:text-slate-400 italic text-xs">${esc(String(r['Complemento'] || '-'))}</td>
        </tr>
      `).join('');
    }

    const resultsEl = document.getElementById('fastNormalizeResults');
    if (resultsEl) resultsEl.classList.remove('hidden');

    const downloadBtn = document.getElementById('downloadFastExcelBtn');
    if (downloadBtn) {
      downloadBtn.onclick = () => {
        if (fastNormalizedWorkbook) {
          XLSX.writeFile(fastNormalizedWorkbook, fastNormalizedFileName);
          toast('Archivo Excel descargado con éxito', 'success');
        }
      };
    }

    toast(`¡Listo! Se agregaron las direcciones corregidas a las ${updatedRows.length} filas.`, 'success');
  } catch (err: any) {
    console.error(err);
    toast('Error procesando el archivo: ' + err.message, 'error');
  }
}

// Inicialización de Eventos DOM
function initApp(): void {
  // Inicializar subida de archivo Excel principal
  const fileEl = document.getElementById('file') as HTMLInputElement | null;
  if (fileEl) {
    fileEl.addEventListener('click', e => e.stopPropagation());
    fileEl.onchange = async e => {
      const target = e.target as HTMLInputElement;
      const f = target.files && target.files[0];
      if (!f) return;
      const welcomeArea = document.getElementById('welcomeUploadArea');
      try {
        const buffer = await f.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        if (!wb || !wb.SheetNames || !wb.SheetNames.length) {
          throw new Error('El archivo seleccionado no contiene hojas de cálculo.');
        }

        const { rows, headers } = extractSheetData(wb);
        if (!rows.length) {
          throw new Error('El archivo Excel está vacío o no contiene filas con datos.');
        }

        const cm: Record<string, any> = {};
        for (const [k, l] of Object.entries(CM_DEFAULTS)) {
          cm[k] = findColSmart(headers, k, rows);
        }

        S.rawRows = rows;
        (S as any).rawHeaders = headers;
        (S as any).cm = cm;

        if (cm.addr) {
          await processRowsWithMapping(rows, headers, cm);
        } else {
          toast('No detectamos automáticamente la columna de Dirección. Por favor selecciónala a continuación.', 'info');
          showColumnMappingModal(rows, headers, cm, async (confirmedCm: any) => {
            await processRowsWithMapping(rows, headers, confirmedCm);
          });
        }
      } catch (err: any) {
        console.error('Error al procesar archivo:', err);
        if (welcomeArea && (!S.destinations || !S.destinations.length)) {
          welcomeArea.classList.remove('hidden');
        }
        toast(err.message || 'Error al procesar el archivo Excel', 'error');
      } finally {
        target.value = '';
      }
    };
  }

  // Subida de archivo modo normalizar rápido
  const fastFileEl = document.getElementById('fastNormalizeFile') as HTMLInputElement | null;
  if (fastFileEl) {
    fastFileEl.onchange = (e: any) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFastNormalize(f);
    };
  }

  // Modos de Operación (Ruteo vs Normalización Rápida)
  const modeRouteBtn = document.getElementById('modeRouteBtn');
  const modeNormalizeBtn = document.getElementById('modeNormalizeBtn');
  const panelRouteMode = document.getElementById('panelRouteMode');
  const panelNormalizeMode = document.getElementById('panelNormalizeMode');

  if (modeRouteBtn && modeNormalizeBtn && panelRouteMode && panelNormalizeMode) {
    modeRouteBtn.onclick = () => {
      modeRouteBtn.className = 'px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 bg-brand-500 text-white shadow-xs';
      modeNormalizeBtn.className = 'px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600';
      panelRouteMode.classList.remove('hidden');
      panelNormalizeMode.classList.add('hidden');
    };

    modeNormalizeBtn.onclick = () => {
      modeNormalizeBtn.className = 'px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 bg-emerald-600 text-white shadow-xs';
      modeRouteBtn.className = 'px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600';
      panelNormalizeMode.classList.remove('hidden');
      panelRouteMode.classList.add('hidden');
    };
  }

  // Botones de descarga de mapa (PRESERVADOS INTACTOS)
  const btnDownloadPng = document.getElementById('btnDownloadMapPng');
  if (btnDownloadPng) btnDownloadPng.onclick = downloadMapAsPng;

  const btnDownloadMapBtn = document.getElementById('downloadMapBtn');
  if (btnDownloadMapBtn) btnDownloadMapBtn.onclick = downloadMapAsPng;

  const btnDownloadPngHeader = document.getElementById('btnDownloadMapPngHeader');
  if (btnDownloadPngHeader) btnDownloadPngHeader.onclick = downloadMapAsPng;

  // Botón replanificar global
  const btnReplanGlobal = document.getElementById('btnReplanRoutes');
  if (btnReplanGlobal) btnReplanGlobal.onclick = () => replanRoutes();

  // Pines y vista
  const btnPinSizeMicroGlobal = document.getElementById('btnPinSizeMicro');
  if (btnPinSizeMicroGlobal) btnPinSizeMicroGlobal.onclick = () => setPinSizeMode('micro');

  const btnPinSizeStandardGlobal = document.getElementById('btnPinSizeStandard');
  if (btnPinSizeStandardGlobal) btnPinSizeStandardGlobal.onclick = () => setPinSizeMode('estandar');

  const btnViewStyleFullGlobal = document.getElementById('btnViewStyleFull');
  if (btnViewStyleFullGlobal) btnViewStyleFullGlobal.onclick = () => setRouteViewStyle('completo');

  const btnViewStylePinsGlobal = document.getElementById('btnViewStylePins');
  if (btnViewStylePinsGlobal) btnViewStylePinsGlobal.onclick = () => setRouteViewStyle('pines');

  // Retorno al depósito
  const returnDepotEl = document.getElementById('returnDepot');
  if (returnDepotEl) {
    returnDepotEl.onchange = () => {
      if (S.routes.length) {
        renderRoutes();
        syncAllRoutesRealDistance();
        if (S.routes[S.currentRouteIndex]) {
          draw(S.routes[S.currentRouteIndex]);
        }
      }
    };
  }

  // Alertas
  const acceptApproxBtn = document.getElementById('acceptApprox');
  if (acceptApproxBtn) {
    acceptApproxBtn.onclick = () => {
      S.alerts.forEach((d: any) => {
        if (!d.lat || !d.lng) {
          const fb = PRE_GEO[d.ciudad.toUpperCase()] || PRE_GEO.BOGOTA;
          d.lat = fb.lat;
          d.lng = fb.lng;
        }
        d.geocoded = true;
        d.confidence = 'Encontrada aproximadamente';
      });
      S.alerts = [];
      const alertsSec = document.getElementById('alertsSec');
      if (alertsSec) alertsSec.classList.add('hidden');
      const statAl = document.querySelector('#statAl div');
      if (statAl) statAl.textContent = '0';
      generate();
    };
  }

  const retryBtn = document.getElementById('retry');
  if (retryBtn) {
    retryBtn.onclick = async () => {
      document.querySelectorAll('.alertAddr').forEach((x: any) => {
        const d = S.alerts.find(y => y.id == x.dataset.id);
        if (d) d.direccion = x.value;
      });
      document.querySelectorAll('.alertLat').forEach((x: any) => {
        const d = S.alerts.find(y => y.id == x.dataset.id);
        if (d && x.value) d.lat = +x.value;
      });
      document.querySelectorAll('.alertLng').forEach((x: any) => {
        const d = S.alerts.find(y => y.id == x.dataset.id);
        if (d && x.value) d.lng = +x.value;
      });

      const manual = S.alerts.filter((d: any) => Number.isFinite(d.lat) && Number.isFinite(d.lng));
      manual.forEach((d: any) => {
        d.geocoded = true;
        d.confidence = 'Ubicación manual';
        d.strategy = 'Ingreso manual por usuario';
      });

      S.alerts = S.alerts.filter((d: any) => !d.geocoded);
      await geocodeAll(true);
    };
  }

  const continueBtn = document.getElementById('continue');
  if (continueBtn) {
    continueBtn.onclick = () => {
      S.destinations = S.destinations.filter(d => d.lat && d.lng);
      const alertsSec = document.getElementById('alertsSec');
      if (alertsSec) alertsSec.classList.add('hidden');
      generate();
    };
  }

  const clearCacheBtn = document.getElementById('clearCacheBtn');
  if (clearCacheBtn) clearCacheBtn.onclick = handleClearCacheAndRegeocode;

  const reGeocodeAllBtn = document.getElementById('reGeocodeAllBtn');
  if (reGeocodeAllBtn) reGeocodeAllBtn.onclick = handleClearCacheAndRegeocode;

  // Inicializar sub-módulos
  initAuthGate();
  initEditModalListeners();
  initToolbarListeners();
  initClientSearchListeners();
  initTelemetrySystem();

  updateDistModeUI();
  updatePinSizeModeUI(S.pinSize || 'micro');
  updateRouteViewStyleUI(S.routeViewStyle);
  renderPolygonToolbarUI();
}

export function switchLeftTab(tab: 'rutas' | 'detalles'): void {
  const btnRutas = document.getElementById('tabPanelRutas');
  const btnDetalles = document.getElementById('tabPanelDetalles');
  const routesEl = document.getElementById('routes');
  const detailsEl = document.getElementById('routesDetailsPanel');

  if (tab === 'rutas') {
    if (btnRutas) btnRutas.className = 'px-3.5 py-1 rounded-full text-[11px] font-extrabold bg-white dark:bg-slate-800 text-[#EA580C] shadow-2xs transition cursor-pointer';
    if (btnDetalles) btnDetalles.className = 'px-3.5 py-1 rounded-full text-[11px] font-bold text-slate-500 dark:text-slate-300 hover:text-slate-800 transition cursor-pointer';
    if (routesEl) routesEl.classList.remove('hidden');
    if (detailsEl) detailsEl.classList.add('hidden');
  } else {
    if (btnDetalles) btnDetalles.className = 'px-3.5 py-1 rounded-full text-[11px] font-extrabold bg-white dark:bg-slate-800 text-[#EA580C] shadow-2xs transition cursor-pointer';
    if (btnRutas) btnRutas.className = 'px-3.5 py-1 rounded-full text-[11px] font-bold text-slate-500 dark:text-slate-300 hover:text-slate-800 transition cursor-pointer';
    if (routesEl) routesEl.classList.add('hidden');
    if (detailsEl) detailsEl.classList.remove('hidden');
  }
}

export function handleCloseShift(): void {
  S.routes = [];
  S.destinations = [];
  S.orders = [];
  S.alerts = [];
  S.rawRows = [];

  if (S.markers) S.markers.clearLayers();
  if (S.routeLayer) S.routeLayer.clearLayers();

  const statDestEl = document.querySelector('#statDest div');
  if (statDestEl) statDestEl.textContent = '0';
  const statPedEl = document.querySelector('#statPedidos div');
  if (statPedEl) statPedEl.textContent = '0';
  const statREl = document.querySelector('#statR div');
  if (statREl) statREl.textContent = '0';
  const statExEl = document.querySelector('#statEx div');
  if (statExEl) statExEl.textContent = '0';

  const countBadge = document.getElementById('routesCountBadge');
  if (countBadge) countBadge.classList.add('hidden');

  const routesEl = document.getElementById('routes');
  if (routesEl) {
    routesEl.innerHTML = '<div class="py-12 px-4 text-center text-xs text-slate-400 dark:text-slate-500">Cargue un archivo o active la demo para generar las rutas.</div>';
  }

  const resultsSec = document.getElementById('resultsSec');
  if (resultsSec) resultsSec.classList.add('hidden');
  const alertsSec = document.getElementById('alertsSec');
  if (alertsSec) alertsSec.classList.add('hidden');
  const welcomeArea = document.getElementById('welcomeUploadArea');
  if (welcomeArea) welcomeArea.classList.remove('hidden');

  clearAllTelemetryTrucks();
  clearAllPolygons(true);
  switchLeftTab('rutas');
  toast('Turno cerrado · Consola lista para nuevo despacho', 'info');
}

export function loadLiveDemo(): void {
  withJamarLoader(() => {
    const demoStops = [
      { id: 1, pedido: 'JM-90411', cliente: 'CARLOS ANDRÉS GÓMEZ', cedula: '79845120', direccion: 'CALLE 15 # 12-40', ciudad: 'FUNZA', barrio: 'CENTRO', vol: 1.85, lat: 4.7168, lng: -74.2124 },
      { id: 2, pedido: 'JM-90412', cliente: 'MARÍA FERNANDA ROJAS', cedula: '52418963', direccion: 'CARRERA 3 # 18-25', ciudad: 'MOSQUERA', barrio: 'EL TREBOL', vol: 2.10, lat: 4.7065, lng: -74.2308 },
      { id: 3, pedido: 'JM-90413', cliente: 'JORGE ELIÉCER PINZÓN', cedula: '80145789', direccion: 'CALLE 7 # 9-50', ciudad: 'MADRID', barrio: 'SOSIEGO', vol: 1.65, lat: 4.7328, lng: -74.2638 },
      { id: 4, pedido: 'JM-90414', cliente: 'DIANA CAROLINA VARGAS', cedula: '1018452369', direccion: 'CARRERA 9 # 14-10', ciudad: 'FUNZA', barrio: 'SERREZUELITA', vol: 1.90, lat: 4.7195, lng: -74.2162 },
      { id: 5, pedido: 'JM-90415', cliente: 'LUIS EDUARDO CASTRO', cedula: '79632145', direccion: 'CALLE 10 # 15-30', ciudad: 'MOSQUERA', barrio: 'PORVENIR', vol: 2.25, lat: 4.7012, lng: -74.2255 },
      { id: 6, pedido: 'JM-90416', cliente: 'PAOLA ANDREA MORENO', cedula: '52963852', direccion: 'CALLE 145 # 91-20', ciudad: 'BOGOTA', barrio: 'SUBA CENTRO', vol: 1.75, lat: 4.7418, lng: -74.0845 },
      { id: 7, pedido: 'JM-90417', cliente: 'CAMILO ERNESTO TORRES', cedula: '1020741852', direccion: 'CARRERA 104 # 152-40', ciudad: 'BOGOTA', barrio: 'SUBA TURINGIA', vol: 2.05, lat: 4.7512, lng: -74.0928 },
      { id: 8, pedido: 'JM-90418', cliente: 'SANDRA MILENA ORTIZ', cedula: '51852963', direccion: 'CALLE 80 # 114-50', ciudad: 'BOGOTA', barrio: 'GRAN GRANADA', vol: 1.60, lat: 4.7185, lng: -74.1225 },
      { id: 9, pedido: 'JM-90419', cliente: 'RICARDO ALFONSO PÉREZ', cedula: '79369258', direccion: 'CALLE 72 # 110-15', ciudad: 'BOGOTA', barrio: 'ÁLAMOS NORTE', vol: 1.95, lat: 4.7042, lng: -74.1180 },
      { id: 10, pedido: 'JM-90420', cliente: 'NATALIA SUÁREZ MÉNDEZ', cedula: '1015852741', direccion: 'CARRERA 100 # 22-45', ciudad: 'BOGOTA', barrio: 'FONTIBÓN CENTRO', vol: 1.80, lat: 4.6736, lng: -74.1438 },
      { id: 11, pedido: 'JM-90421', cliente: 'ÓSCAR IVÁN HERNÁNDEZ', cedula: '80741963', direccion: 'CALLE 134 # 45-20', ciudad: 'BOGOTA', barrio: 'PRADO VERANIEGO', vol: 2.15, lat: 4.7192, lng: -74.0548 },
      { id: 12, pedido: 'JM-90422', cliente: 'CLAUDIA PATRICIA LÓPEZ', cedula: '52741369', direccion: 'CALLE 170 # 54-15', ciudad: 'BOGOTA', barrio: 'VILLA DEL PRADO', vol: 1.70, lat: 4.7545, lng: -74.0562 }
    ];

    S.destinations = demoStops.map(d => {
      const dest: any = {
        id: d.id,
        cliente: d.cliente,
        clienteDisplay: d.cliente,
        destinatario: d.cliente,
        cedula: d.cedula,
        direccionOriginal: d.direccion,
        direccion: d.direccion,
        complemento: '',
        ciudad: d.ciudad,
        barrio: d.barrio,
        telefono: '3100000000',
        vol: d.vol,
        pedidos: [d.pedido],
        numOrders: 1,
        isMultiDelivery: false,
        entregas: [],
        lat: d.lat,
        lng: d.lng,
        geocoded: true,
        confidence: 'Demo en Vivo',
        strategy: 'Coordenadas Verificadas Cendis Siberia',
        zone: 'BOGOTA_OCCIDENTE'
      };
      dest.zone = classifyZone(dest);
      return dest;
    });

    S.orders = demoStops.map(d => ({
      id: d.id,
      pedido: d.pedido,
      cliente: d.cliente,
      direccionOriginal: d.direccion,
      direccion: d.direccion,
      ciudad: d.ciudad,
      barrio: d.barrio,
      telefono: '3100000000',
      vol: d.vol,
      descripcion: 'Muebles Jamar',
      lat: d.lat,
      lng: d.lng,
      zone: 'BOGOTA_OCCIDENTE',
      raw: {}
    })) as any;

    S.stats = {
      rows: demoStops.length,
      orders: demoStops.length,
      destinations: demoStops.length,
      cityExcluded: 0,
      freightExcluded: 0,
      cendisExcluded: 0,
      branchHomologated: 0,
      cities: {},
      corrected: {},
      excludedRows: []
    };

    const welcomeArea = document.getElementById('welcomeUploadArea');
    if (welcomeArea) welcomeArea.classList.add('hidden');

    const statDestEl = document.querySelector('#statDest div');
    if (statDestEl) statDestEl.textContent = String(S.destinations.length);
    const statPedEl = document.querySelector('#statPedidos div');
    if (statPedEl) statPedEl.textContent = String(S.orders.length);
    const statExEl = document.querySelector('#statEx div');
    if (statExEl) statExEl.textContent = '0';

    showSummary(S.stats);
    switchLeftTab('rutas');
    generate();
  }, 'DEMO JAMAR', 'Cargando flota de prueba y pedidos de Cendis Siberia...', 1100);
}

export function toggleDarkSidebar(forceCollapse?: boolean): void {
  const sidebar = document.getElementById('mainDarkSidebar');
  const icon = document.getElementById('darkSidebarToggleIcon');
  if (!sidebar) return;

  const willCollapse =
    typeof forceCollapse === 'boolean'
      ? forceCollapse
      : !sidebar.classList.contains('sidebar-collapsed');

  if (willCollapse) {
    sidebar.classList.add('sidebar-collapsed');
    sidebar.style.width = '68px';
    if (icon) icon.style.transform = 'rotate(180deg)';
  } else {
    sidebar.classList.remove('sidebar-collapsed');
    sidebar.style.width = '235px';
    if (icon) icon.style.transform = 'rotate(0deg)';
  }

  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 260);
}

export function toggleRoutesColumn(forceCollapse?: boolean): void {
  const col = document.getElementById('routesColumnPanel');
  const btn = document.getElementById('btnToggleRoutesCol');
  if (!col) return;

  const isCurrentlyCollapsed = col.classList.contains('routes-col-collapsed');
  const willCollapse =
    typeof forceCollapse === 'boolean' ? forceCollapse : !isCurrentlyCollapsed;

  if (willCollapse) {
    col.classList.add('routes-col-collapsed');
    if (btn) {
      btn.className = 'w-8 h-8 rounded-xl border border-orange-300 bg-orange-50 text-[#EA580C] flex items-center justify-center transition cursor-pointer shrink-0 shadow-2xs';
      btn.title = 'Mostrar columna de listado de rutas';
    }
  } else {
    col.classList.remove('routes-col-collapsed');
    if (btn) {
      btn.className = 'w-8 h-8 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 text-slate-600 dark:text-slate-300 flex items-center justify-center transition cursor-pointer shrink-0';
      btn.title = 'Mostrar / Ocultar columna de listado de rutas para ampliar el mapa';
    }
  }

  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 260);
}

// Exposición global en window para garantizar retrocompatibilidad 100%
if (typeof window !== 'undefined') {
  (window as any).generate = generate;
  (window as any).geocodeAll = geocodeAll;
  (window as any).handleClearCacheAndRegeocode = handleClearCacheAndRegeocode;
  (window as any).processRowsWithMapping = processRowsWithMapping;
  (window as any).downloadMapAsPng = downloadMapAsPng;
  (window as any).captureMap = downloadMapAsPng;
  (window as any).openEditLocationModal = openEditLocationModal;
  (window as any).closeEditLocationModal = closeEditLocationModal;
  (window as any).openReassignModal = openReassignModal;
  (window as any).showSummary = showSummary;
  (window as any).loadLiveDemo = loadLiveDemo;
  (window as any).handleCloseShift = handleCloseShift;
  (window as any).switchLeftTab = switchLeftTab;
  (window as any).toggleDarkSidebar = toggleDarkSidebar;
  (window as any).toggleRoutesColumn = toggleRoutesColumn;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
