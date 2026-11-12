import { DEPOT } from '../config/constants';
import { draw } from '../map/leafletMap';
import { esc, S, toast } from '../state/store';
import { active } from './routing';
import { getRouteDailyPin, isDriverSessionAuthenticated, persistDriverSession, verifyDriverPin } from './auth';

declare const L: any;

export interface TruckTelemetry {
  truckId: string;
  routeId: number;
  routeName: string;
  routeColor: string;
  vehiclePlate: string;
  driverName: string;
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  accuracy: number | null;
  status: 'en_ruta' | 'entregando' | 'detenido' | 'completado';
  statusNote?: string;
  statusSince?: number;
  currentStopIndex: number;
  totalStops: number;
  completedStopIds: number[];
  nextStopClient?: string;
  nextStopAddress?: string;
  updatedAt: number;
  source: 'gps_movil' | 'demo_gps';
  trail?: Array<{ lat: number; lng: number; ts: number }>;
  eventLog?: Array<{ time: string; text: string; status: string }>;
}

// Estado en memoria sincronizado con el servidor WebSocket
export const telemetryState = {
  trucks: new Map<string, TruckTelemetry>(),
  wsConnected: false,
  followingTruckId: null as string | null,
  activeRightTab: 'controls' as 'controls' | 'office' | 'driver',
  // Modo Exclusivo Conductor (bloquea paneles de edición del coordinador)
  isDriverExclusiveMode: false,
  isDriverLockedByUrl: false,
  // Casilla de seguridad del Administrador (false = bloqueado en modo solo lectura para evitar errores)
  adminOverrideUnlocked: false,
  // Disposición móvil para el conductor (< 768px): 'split' (mapa arriba + lista abajo) | 'list' (solo entregas) | 'map' (solo mapa)
  mobileDriverLayout: 'split' as 'split' | 'list' | 'map',
  // Estado del transmisor móvil del conductor
  driverWatchId: null as number | null,
  driverIntervalId: null as any,
  driverUiTickerId: null as any,
  driverIsTransmitting: false,
  driverSelectedRouteId: 0,
  driverPlate: 'JMR-101',
  driverName: 'Conductor Ruta 1',
  driverStatus: 'en_ruta' as 'en_ruta' | 'entregando' | 'detenido' | 'completado',
  driverStatusNote: 'En tránsito hacia próximo cliente',
  driverStatusSince: Date.now(),
  driverIntervalSec: 10,
  driverLastCoords: null as {
    lat: number;
    lng: number;
    speedKmh: number;
    heading: number | null;
    accuracy: number | null;
  } | null,
  driverGpsHardwareState: 'idle' as 'idle' | 'active' | 'disabled_on_device' | 'permission_denied' | 'searching',
  driverPacketsSent: 0,
  driverLastSentAt: 0,
  driverCompletedStops: new Set<number>(),
  driverEventLog: [] as Array<{ time: string; text: string; status: string }>,
  // Transmisor de prueba sobre trazado OSRM
  fleetDemoTimer: null as any,
  fleetDemoActive: false
};

let wsClient: WebSocket | null = null;
let reconnectTimer: any = null;
let broadcastChan: BroadcastChannel | null = null;
let mapTelemetryLayer: any = null;
let mapCompletedStopsLayer: any = null;
const truckMarkersMap = new Map<string, { marker: any; trailLine: any }>();

function nowTimeStr(): string {
  const d = new Date();
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function isDriverActionLocked(): boolean {
  // Si el usuario abrió la app mediante el link directo de conductor (?modo=conductor), es el chofer real -> controles habilitados.
  // Si entró desde la consola de Administrador, está bloqueado por defecto a menos que marque la casilla de advertencia.
  return !telemetryState.isDriverLockedByUrl && !telemetryState.adminOverrideUnlocked;
}

export function toggleAdminDriverOverride(unlocked: boolean): void {
  telemetryState.adminOverrideUnlocked = Boolean(unlocked);
  const checkbox = document.getElementById('adminUnlockDriverControlsCheckbox') as HTMLInputElement | null;
  if (checkbox) {
    checkbox.checked = telemetryState.adminOverrideUnlocked;
  }
  if (telemetryState.adminOverrideUnlocked) {
    toast('⚠️ Manipulación manual habilitada. Cualquier cambio afectará en vivo el viaje del conductor.', 'warn');
  } else {
    toast('🔒 Modo Supervisión activado (Solo lectura). El viaje del conductor está protegido.', 'info');
  }
  renderTelemetryPanelUI();
}

export function getFirebaseDatabaseUrl(): string {
  if (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.FIREBASE_DATABASE_URL) {
    return (window as any).__APP_CONFIG__.FIREBASE_DATABASE_URL;
  }
  try {
    if ((import.meta as any).env?.VITE_FIREBASE_DATABASE_URL) {
      return (import.meta as any).env.VITE_FIREBASE_DATABASE_URL;
    }
  } catch (_e) {}
  return '';
}

export function getFirebaseAuthSecret(): string {
  if (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.FIREBASE_AUTH_SECRET) {
    return (window as any).__APP_CONFIG__.FIREBASE_AUTH_SECRET;
  }
  try {
    if ((import.meta as any).env?.VITE_FIREBASE_AUTH_SECRET) {
      return (import.meta as any).env.VITE_FIREBASE_AUTH_SECRET;
    }
  } catch (_e) {}
  return '';
}

let firebaseAuthDisabled = false;

export function buildFirebaseUrl(endpoint: string): string {
  if (firebaseAuthDisabled) return '';
  const fbUrl = getFirebaseDatabaseUrl();
  if (!fbUrl) return '';
  const cleanUrl = fbUrl.replace(/\/+$/, '');
  const secret = getFirebaseAuthSecret();
  const sep = endpoint.includes('?') ? '&' : '?';
  const authParam = secret ? `${sep}auth=${encodeURIComponent(secret)}` : '';
  return `${cleanUrl}${endpoint}${authParam}`;
}

export function handleFirebaseResponseStatus(status: number): void {
  if (status === 401 || status === 403) {
    if (!firebaseAuthDisabled) {
      firebaseAuthDisabled = true;
      console.warn(
        '[Firebase] Acceso a la base de datos no autorizado (401/403). La sincronización en la nube se ha pausado para evitar saturación de consola. Para reactivarla, agrega VITE_FIREBASE_AUTH_SECRET en Vercel o ajusta las reglas de seguridad en Firebase Console.'
      );
    }
  }
}

export function getTodayDateKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getYesterdayDateKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface BitacoraEntry {
  id: string;
  date: string;
  time: string;
  routeId: number;
  routeName: string;
  vehiclePlate: string;
  driverName: string;
  status: string;
  completedStopsCount: number;
  totalStops: number;
  text: string;
}

export function saveBitacoraRecord(entry: Omit<BitacoraEntry, 'id' | 'date'>): void {
  const dateKey = getTodayDateKey();
  const fullEntry: BitacoraEntry = {
    id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    date: dateKey,
    ...entry
  };

  // 1. Guardar en localStorage (memoria local resiliente para descarga inmediata)
  try {
    const storageKey = `rutasjamar_bitacora_${dateKey}`;
    const raw = localStorage.getItem(storageKey);
    const list: BitacoraEntry[] = raw ? JSON.parse(raw) : [];
    list.unshift(fullEntry);
    if (list.length > 500) list.length = 500;
    localStorage.setItem(storageKey, JSON.stringify(list));
  } catch (_e) {}

  // 2. Si Firebase Realtime Database está configurado, sincronizar con la nube protegida
  const targetUrl = buildFirebaseUrl(`/bitacora/${dateKey}/${fullEntry.id}.json`);
  if (targetUrl) {
    fetch(targetUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fullEntry)
    })
      .then(r => {
        if (!r.ok) handleFirebaseResponseStatus(r.status);
      })
      .catch(() => {});
  }
}

export function purgeOldBitacoraRecords(): void {
  const today = getTodayDateKey();
  const yesterday = getYesterdayDateKey();

  // 1. Limpieza en localStorage: purgar registros de más de 48 horas (conserva solo hoy y ayer)
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('rutasjamar_bitacora_')) {
        const d = k.replace('rutasjamar_bitacora_', '');
        if (d !== today && d !== yesterday) {
          keysToRemove.push(k);
        }
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (_e) {}

  // 2. Limpieza en Firebase: eliminar carpetas de más de 48 horas para ahorrar espacio total
  const checkUrl = buildFirebaseUrl('/telemetria.json?shallow=true');
  if (checkUrl) {
    fetch(checkUrl)
      .then(r => {
        if (!r.ok) {
          handleFirebaseResponseStatus(r.status);
          return null;
        }
        return r.json();
      })
      .then(datesObj => {
        if (datesObj && typeof datesObj === 'object') {
          Object.keys(datesObj).forEach(d => {
            if (d !== today && d !== yesterday) {
              const delTelem = buildFirebaseUrl(`/telemetria/${d}.json`);
              const delBit = buildFirebaseUrl(`/bitacora/${d}.json`);
              const delRoutes = buildFirebaseUrl(`/rutas_activas/${d}.json`);
              if (delTelem) fetch(delTelem, { method: 'DELETE' }).catch(() => {});
              if (delBit) fetch(delBit, { method: 'DELETE' }).catch(() => {});
              if (delRoutes) fetch(delRoutes, { method: 'DELETE' }).catch(() => {});
            }
          });
        }
      })
      .catch(() => {});
  }
}

export function syncTruckToCloud(truck: TruckTelemetry): void {
  const today = getTodayDateKey();
  const targetUrl = buildFirebaseUrl(`/telemetria/${today}/${truck.truckId}.json`);
  if (!targetUrl) return;
  fetch(targetUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(truck)
  })
    .then(r => {
      if (!r.ok) handleFirebaseResponseStatus(r.status);
    })
    .catch(() => {});
}

export async function pullTelemetryFromCloud(): Promise<void> {
  const today = getTodayDateKey();
  const targetUrl = buildFirebaseUrl(`/telemetria/${today}.json`);
  if (!targetUrl) return;
  try {
    const res = await fetch(targetUrl);
    if (!res.ok) {
      handleFirebaseResponseStatus(res.status);
      return;
    }
    const data = await res.json();
    if (data && typeof data === 'object') {
      let changed = false;
      Object.values(data).forEach((truck: any) => {
        if (truck && truck.truckId) {
          const local = telemetryState.trucks.get(truck.truckId);
          if (!local || (truck.updatedAt && truck.updatedAt >= (local.updatedAt || 0))) {
            telemetryState.trucks.set(truck.truckId, truck);
            changed = true;
          }
        }
      });
      if (changed) {
        if (!telemetryState.driverIsTransmitting) {
          syncLocalDriverStateFromLiveTruck(telemetryState.driverSelectedRouteId);
        }
        renderTelemetryOnMap();
        renderTelemetryPanelUI();
      }
    }

    // Si el dispositivo (como el celular del chofer) no tiene las rutas cargadas en memoria, sincronizarlas desde la nube
    if (!S.routes || !S.routes.length) {
      await syncActiveRoutesFromCloud(today);
    }
  } catch (_e) {}
}

export async function syncActiveRoutesFromCloud(targetDate?: string): Promise<boolean> {
  const dateKey = targetDate || getTodayDateKey();
  const routesUrl = buildFirebaseUrl(`/rutas_activas/${dateKey}.json`);
  if (!routesUrl) return false;
  try {
    const res = await fetch(routesUrl);
    if (!res.ok) {
      handleFirebaseResponseStatus(res.status);
      return false;
    }
    const cloudRoutes = await res.json();
    if (Array.isArray(cloudRoutes) && cloudRoutes.length > 0) {
      S.routes = cloudRoutes;

      const welcomeArea = document.getElementById('welcomeUploadArea');
      const resultsSec = document.getElementById('resultsSec');
      if (welcomeArea) welcomeArea.classList.add('hidden');
      if (resultsSec) resultsSec.classList.remove('hidden');
      if ((window as any).initMap) (window as any).initMap();

      const loaderOverlay = document.getElementById('driverRouteSyncOverlay');
      if (loaderOverlay) loaderOverlay.remove();

      if (telemetryState.isDriverExclusiveMode) {
        centerDriverAssignedRoute();
      }
      renderTelemetryPanelUI();
      renderTelemetryOnMap();
      return true;
    }
    return false;
  } catch (_e) {
    return false;
  }
}

export function showDriverRouteSyncLoader(dateKey: string): void {
  let overlay = document.getElementById('driverRouteSyncOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'driverRouteSyncOverlay';
    overlay.className = 'fixed inset-0 z-[99998] bg-[#0F172A] flex flex-col items-center justify-center p-6 text-center select-none';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="max-w-sm w-full bg-[#1E293B] border border-orange-500/30 rounded-3xl p-6 sm:p-8 space-y-4 shadow-2xl text-center">
      <div class="w-16 h-16 rounded-2xl bg-[#EA580C]/20 border border-[#EA580C]/30 text-[#EA580C] flex items-center justify-center text-3xl mx-auto animate-pulse">
        🚛
      </div>
      <h3 class="text-white text-lg font-black">Descargando Hoja de Ruta</h3>
      <p class="text-xs text-slate-300 leading-relaxed">
        Sincronizando clientes y paradas de entrega con Central Jamar Cendis Siberia...
      </p>
      <div class="py-2.5 px-4 rounded-xl bg-slate-900/80 border border-slate-700/80 text-[11px] text-orange-400 font-semibold flex items-center justify-center gap-2">
        <span class="w-2 h-2 rounded-full bg-[#EA580C] animate-ping"></span>
        <span>Conectando con la nube (${esc(dateKey)})...</span>
      </div>
    </div>
  `;
}

export function updateDriverRouteSyncLoaderNotFound(dateKey: string, routeId: number): void {
  const overlay = document.getElementById('driverRouteSyncOverlay');
  if (!overlay) return;
  overlay.innerHTML = `
    <div class="max-w-sm w-full bg-[#1E293B] border border-amber-500/40 rounded-3xl p-6 sm:p-8 space-y-4 shadow-2xl text-center">
      <div class="w-16 h-16 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center text-3xl mx-auto">
        ⏳
      </div>
      <h3 class="text-white text-lg font-black">Ruta no publicada aún</h3>
      <p class="text-xs text-slate-300 leading-relaxed">
        Central Jamar Cendis aún no ha emitido la hoja de ruta digital para la <b>Ruta ${routeId + 1}</b> hoy (${esc(dateKey)}).
      </p>
      <div class="p-3 rounded-2xl bg-slate-900/80 border border-slate-800 text-[11px] text-slate-400">
        Pide a tu Coordinador de Despacho que haga clic en <b>Copiar Link</b> o publique las rutas.
      </div>
      <button type="button" onclick="window.syncActiveRoutesFromCloud && window.syncActiveRoutesFromCloud('${dateKey}')" class="w-full py-3 px-4 rounded-2xl bg-[#EA580C] hover:bg-[#D94E06] text-white font-extrabold text-xs shadow-lg shadow-orange-600/30 transition cursor-pointer flex items-center justify-center gap-2">
        <span>🔄</span>
        <span>Reintentar Sincronización</span>
      </button>
    </div>
  `;
}

export function getGoogleMapsNavigationUrl(stop: any): string {
  if (!stop) return 'https://maps.google.com';
  const lat = Number(stop.lat);
  const lng = Number(stop.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving&dir_action=navigate`;
  }
  const addrClean = `${stop.direccion || ''}, ${stop.ciudad || 'Bogotá'}, Colombia`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addrClean)}`;
}

export async function downloadBitacoraReport(day: string = 'hoy'): Promise<void> {
  const targetDate = day === 'ayer' ? getYesterdayDateKey() : getTodayDateKey();
  let entries: BitacoraEntry[] = [];

  // 1. Obtener de localStorage
  try {
    const raw = localStorage.getItem(`rutasjamar_bitacora_${targetDate}`);
    if (raw) {
      entries = JSON.parse(raw);
    }
  } catch (_e) {}

  // 2. Si Firebase está configurado, consultar también para consolidar
  const cloudUrl = buildFirebaseUrl(`/bitacora/${targetDate}.json`);
  if (cloudUrl) {
    try {
      const res = await fetch(cloudUrl);
      if (res.ok) {
        const cloudData = await res.json();
        if (cloudData && typeof cloudData === 'object') {
          const cloudEntries: BitacoraEntry[] = Object.values(cloudData);
          const existingIds = new Set(entries.map(e => e.id));
          cloudEntries.forEach(ce => {
            if (!existingIds.has(ce.id)) {
              entries.push(ce);
              existingIds.add(ce.id);
            }
          });
        }
      }
    } catch (_e) {}
  }

  // 3. Respaldo: si no hay entradas en almacenamiento pero el usuario seleccionó "hoy", extraer de memoria
  if (entries.length === 0 && day === 'hoy') {
    Array.from(telemetryState.trucks.values()).forEach(t => {
      if (Array.isArray(t.eventLog)) {
        t.eventLog.forEach(ev => {
          entries.push({
            id: `${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            date: targetDate,
            time: ev.time || nowTimeStr(),
            routeId: t.routeId,
            routeName: t.routeName,
            vehiclePlate: t.vehiclePlate,
            driverName: t.driverName,
            status: ev.status || t.status,
            completedStopsCount: Array.isArray(t.completedStopIds) ? t.completedStopIds.length : 0,
            totalStops: t.totalStops || 0,
            text: ev.text
          });
        });
      }
    });
  }

  if (entries.length === 0) {
    toast(`No hay eventos registrados en la bitácora para ${day === 'ayer' ? 'el día de ayer (' + targetDate + ')' : 'el día de hoy (' + targetDate + ')'}.`, 'info');
    return;
  }

  // Ordenar cronológicamente (más recientes primero)
  entries.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

  // Construir CSV compatible con Excel en español (delimitado por ';' y codificado en UTF-8 con BOM)
  const header = ['Fecha', 'Hora', 'Ruta', 'Placa Camión', 'Conductor', 'Estado Operativo', 'Entregas', 'Detalle de Evento / Novedad'];
  const rows = entries.map(e => [
    e.date,
    e.time,
    e.routeName || `Ruta ${e.routeId + 1}`,
    e.vehiclePlate,
    e.driverName,
    e.status === 'en_ruta' ? 'En Tránsito' : e.status === 'entregando' ? 'Entregando' : e.status === 'detenido' ? 'Detenido' : 'Completado',
    `${e.completedStopsCount || 0}/${e.totalStops || 0}`,
    `"${(e.text || '').replace(/"/g, '""')}"`
  ]);

  const csvContent = '\uFEFF' + [header.join(';'), ...rows.map(r => r.join(';'))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Bitacora_Entregas_Jamar_${targetDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  toast(`📥 Bitácora de Entregas (${targetDate}) descargada con éxito (${entries.length} eventos).`, 'success');
}

function addDriverLogEvent(text: string, status = telemetryState.driverStatus): void {
  const entry = {
    time: nowTimeStr(),
    text,
    status
  };
  telemetryState.driverEventLog.unshift(entry);
  if (telemetryState.driverEventLog.length > 25) {
    telemetryState.driverEventLog.length = 25;
  }

  // También sincronizar inmediatamente con el camión en memoria para que la vista de Oficina lo tenga al instante
  const truckId = `ruta-${telemetryState.driverSelectedRouteId + 1}`;
  const existing = telemetryState.trucks.get(truckId);
  if (existing) {
    existing.eventLog = [...telemetryState.driverEventLog];
  }

  // Guardar en la bitácora persistente (conserva 2 días)
  const rIdx = telemetryState.driverSelectedRouteId;
  const route = S.routes ? S.routes[rIdx] : null;
  const totalStops = route?.stops ? route.stops.length : (existing?.totalStops || 0);
  saveBitacoraRecord({
    time: entry.time,
    routeId: rIdx,
    routeName: existing?.routeName || `Ruta ${rIdx + 1}`,
    vehiclePlate: telemetryState.driverPlate || existing?.vehiclePlate || `JMR-${101 + rIdx}`,
    driverName: telemetryState.driverName || existing?.driverName || `Conductor Ruta ${rIdx + 1}`,
    status,
    completedStopsCount: telemetryState.driverCompletedStops.size,
    totalStops,
    text
  });
}

function syncLocalDriverStateFromLiveTruck(routeId: number): void {
  const truck = telemetryState.trucks.get(`ruta-${routeId + 1}`);
  if (!truck) return;

  telemetryState.driverPlate = truck.vehiclePlate || `JMR-${101 + routeId}`;
  telemetryState.driverName = truck.driverName || `Conductor Ruta ${routeId + 1}`;
  telemetryState.driverStatus = truck.status || 'en_ruta';
  if (truck.statusNote) telemetryState.driverStatusNote = truck.statusNote;
  if (truck.statusSince) telemetryState.driverStatusSince = truck.statusSince;

  if (Array.isArray(truck.completedStopIds)) {
    telemetryState.driverCompletedStops = new Set<number>(truck.completedStopIds);
  }
  if (Array.isArray(truck.eventLog) && truck.eventLog.length > 0) {
    telemetryState.driverEventLog = [...truck.eventLog];
  }
  if (Number.isFinite(truck.lat) && Number.isFinite(truck.lng)) {
    telemetryState.driverLastCoords = {
      lat: truck.lat,
      lng: truck.lng,
      speedKmh: truck.speedKmh || 0,
      heading: truck.heading ?? null,
      accuracy: truck.accuracy ?? 10
    };
  }
}

function formatDurationMinSec(sinceMs: number): string {
  const totalSec = Math.max(0, Math.floor((Date.now() - (sinceMs || Date.now())) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function ensureTelemetryMapLayer(): any {
  if (!S.map) return null;
  if (!mapTelemetryLayer || !S.map.hasLayer(mapTelemetryLayer)) {
    mapTelemetryLayer = L.layerGroup().addTo(S.map);
  }
  return mapTelemetryLayer;
}

function ensureCompletedStopsMapLayer(): any {
  if (!S.map) return null;
  if (!mapCompletedStopsLayer || !S.map.hasLayer(mapCompletedStopsLayer)) {
    mapCompletedStopsLayer = L.layerGroup().addTo(S.map);
  }
  return mapCompletedStopsLayer;
}

function getRouteColorById(routeId: number): string {
  const r = (S.routes || []).find(x => x.id === routeId);
  if (r && r.color) return r.color;
  return S.colors[routeId % S.colors.length] || '#EA580C';
}

function formatTimeAgo(ts: number): string {
  if (!ts) return 'sin señal';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'ahora mismo';
  if (sec < 60) return `hace ${sec}s`;
  const min = Math.floor(sec / 60);
  return `hace ${min}m`;
}

function getStatusBadgeHtml(status: TruckTelemetry['status']): string {
  switch (status) {
    case 'en_ruta':
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>En Ruta</span>';
    case 'entregando':
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-950/80 dark:text-amber-300 border border-amber-300 dark:border-amber-700"><span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>📦 Entregando</span>';
    case 'detenido':
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-300 dark:border-rose-700"><span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping"></span>⏸️ Pausa / Tráfico</span>';
    case 'completado':
      return '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 dark:bg-blue-950/80 dark:text-blue-300 border border-blue-300 dark:border-blue-700">✅ Fin de Ruta</span>';
  }
}

export function renderCompletedStopsBadgesOnMap(): void {
  if (!S.map) return;
  const layer = ensureCompletedStopsMapLayer();
  if (!layer) return;
  layer.clearLayers();

  const completedIds = new Set<number>(telemetryState.driverCompletedStops);
  telemetryState.trucks.forEach((t) => {
    if (Array.isArray(t.completedStopIds)) {
      t.completedStopIds.forEach(id => completedIds.add(id));
    }
  });

  if (!completedIds.size) return;

  (S.routes || []).forEach((r: any) => {
    if (telemetryState.isDriverExclusiveMode && r.id !== telemetryState.driverSelectedRouteId) return;
    const stops = active(r) || [];
    stops.forEach((st: any, idx: number) => {
      if (completedIds.has(st.id) && Number.isFinite(st.lat) && Number.isFinite(st.lng)) {
        const badgeIcon = L.divIcon({
          html: `
            <div style="background:#059669;color:#ffffff;border:2px solid #ffffff;border-radius:9999px;padding:1px 6px;font-size:10px;font-weight:800;box-shadow:0 3px 8px rgba(0,0,0,0.35);display:inline-flex;align-items:center;gap:3px;white-space:nowrap;">
              <span>✓</span><span>#${idx + 1} Entregado</span>
            </div>
          `,
          className: 'custom-pin-marker-container',
          iconSize: [90, 22],
          iconAnchor: [45, -8]
        });
        L.marker([st.lat, st.lng], { icon: badgeIcon, zIndexOffset: 1900, interactive: false }).addTo(layer);
      }
    });
  });
}

export function renderTelemetryOnMap(): void {
  if (!S.map) return;
  const layer = ensureTelemetryMapLayer();
  if (!layer) return;

  const currentIds = new Set<string>();

  // Si el Coordinador no tiene rutas cargadas en memoria, limpiar todo marcador huérfano y salir
  if (!telemetryState.isDriverExclusiveMode) {
    if (!S.routes || !S.routes.length) {
      layer.clearLayers();
      truckMarkersMap.clear();
      return;
    }
  }

  telemetryState.trucks.forEach((truck) => {
    if (!Number.isFinite(truck.lat) || !Number.isFinite(truck.lng)) return;

    // En modo exclusivo conductor: mostrar únicamente el camión de su propia ruta
    if (telemetryState.isDriverExclusiveMode) {
      if (truck.routeId !== telemetryState.driverSelectedRouteId) return;
    } else {
      // En modo Coordinador: solo mostrar camiones cuya ruta esté planificada y visible en la sesión actual
      const activeRoute = (S.routes || []).find((r: any) => r.id === truck.routeId);
      if (!activeRoute || activeRoute.visible === false) return;
    }

    currentIds.add(truck.truckId);

    const color = truck.routeColor || getRouteColorById(truck.routeId);
    const statusPillBg =
      truck.status === 'entregando'
        ? '#D97706'
        : truck.status === 'detenido'
          ? '#E11D48'
          : truck.status === 'completado'
            ? '#2563EB'
            : '#059669';

    const statusLabel =
      truck.status === 'entregando'
        ? '📦 Entregando'
        : truck.status === 'detenido'
          ? '⏸️ En Pausa'
          : truck.status === 'completado'
            ? '✅ Fin Ruta'
            : `🟢 ${Math.round(truck.speedKmh || 0)} km/h`;

    const iconHtml = `
      <div style="position:relative;display:flex;align-items:center;justify-content:center;">
        <span style="position:absolute;width:42px;height:42px;border-radius:9999px;background:${statusPillBg};opacity:0.28;animation:ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></span>
        <div style="position:relative;z-index:2;background:#14171F;color:#FFFFFF;border:2.5px solid ${color};border-radius:9999px;padding:3px 9px;display:inline-flex;align-items:center;gap:5px;box-shadow:0 6px 16px rgba(0,0,0,0.35);white-space:nowrap;font-family:'Inter',sans-serif;">
          <span style="font-size:13px;line-height:1;">🚛</span>
          <span style="font-size:11px;font-weight:800;color:${color};">R${truck.routeId + 1}</span>
          <span style="font-size:10px;font-weight:700;color:#F8FAFC;">${esc(truck.vehiclePlate)}</span>
          <span style="font-size:9.5px;font-weight:700;background:${statusPillBg};padding:1.5px 6px;border-radius:9999px;color:#FFFFFF;">${statusLabel}</span>
        </div>
      </div>
    `;

    const customIcon = L.divIcon({
      html: iconHtml,
      className: 'custom-pin-marker-container',
      iconSize: [155, 34],
      iconAnchor: [77, 17]
    });

    const latestLog = truck.eventLog && truck.eventLog.length > 0 ? truck.eventLog[0] : null;

    const popupHtml = `
      <div class="text-xs space-y-1.5 min-w-[230px]">
        <div class="flex items-center justify-between pb-1.5 border-b border-slate-200 dark:border-slate-700">
          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span>
            <strong class="text-slate-900 dark:text-white text-xs">${esc(truck.routeName)} · ${esc(truck.vehiclePlate)}</strong>
          </div>
          ${getStatusBadgeHtml(truck.status)}
        </div>
        <div class="text-slate-600 dark:text-slate-300">👤 <b>Conductor:</b> ${esc(truck.driverName)}</div>
        ${truck.statusNote ? `
          <div class="p-1.5 rounded-lg ${truck.status === 'detenido' ? 'bg-rose-50 text-rose-700 border border-rose-200' : truck.status === 'entregando' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'} text-[11px] font-semibold">
            📌 ${esc(truck.statusNote)}
          </div>
        ` : ''}
        <div class="grid grid-cols-2 gap-1.5 bg-slate-50 dark:bg-slate-800 p-2 rounded-lg border border-slate-200/70 dark:border-slate-700 text-[11px]">
          <div>🚀 <b>Velocidad:</b> ${Math.round(truck.speedKmh || 0)} km/h</div>
          <div>🎯 <b>Precisión:</b> ±${Math.round(truck.accuracy || 10)} m</div>
          <div class="col-span-2">📦 <b>Avance:</b> ${truck.completedStopIds?.length || 0} / ${truck.totalStops || 0} paradas entregadas</div>
        </div>
        ${latestLog ? `
          <div class="text-[10.5px] bg-slate-100 dark:bg-slate-700/70 p-1.5 rounded-lg text-slate-700 dark:text-slate-200">
            📋 <b>Bitácora (${esc(latestLog.time)}):</b> ${esc(latestLog.text)}
          </div>
        ` : ''}
        ${truck.nextStopClient ? `
          <div class="text-[11px] text-slate-600 dark:text-slate-300">
            📍 <b>Próximo cliente:</b> ${esc(truck.nextStopClient)}<br>
            <span class="text-slate-400">${esc(truck.nextStopAddress || '')}</span>
          </div>
        ` : ''}
        <div class="text-[10px] text-slate-400 flex justify-between items-center pt-1">
          <span>Lat: ${truck.lat.toFixed(5)}, Lng: ${truck.lng.toFixed(5)}</span>
          <span>📡 ${formatTimeAgo(truck.updatedAt)}</span>
        </div>
      </div>
    `;

    const existingEntry = truckMarkersMap.get(truck.truckId);
    if (existingEntry) {
      existingEntry.marker.setLatLng([truck.lat, truck.lng]);
      existingEntry.marker.setIcon(customIcon);
      existingEntry.marker.setPopupContent(popupHtml);
      if (existingEntry.trailLine && layer.hasLayer(existingEntry.trailLine)) {
        layer.removeLayer(existingEntry.trailLine);
        existingEntry.trailLine = null;
      }
    } else {
      const marker = L.marker([truck.lat, truck.lng], {
        icon: customIcon,
        zIndexOffset: 2500
      })
        .bindPopup(popupHtml)
        .addTo(layer);

      truckMarkersMap.set(truck.truckId, { marker, trailLine: null });
    }

    if (telemetryState.followingTruckId === truck.truckId && S.map) {
      S.map.panTo([truck.lat, truck.lng], { animate: true, duration: 0.6 });
    }
  });

  // Limpiar marcadores de camiones eliminados o no visibles
  Array.from(truckMarkersMap.keys()).forEach((id) => {
    if (!currentIds.has(id)) {
      const entry = truckMarkersMap.get(id);
      if (entry) {
        if (entry.marker && layer.hasLayer(entry.marker)) layer.removeLayer(entry.marker);
        if (entry.trailLine && layer.hasLayer(entry.trailLine)) layer.removeLayer(entry.trailLine);
      }
      truckMarkersMap.delete(id);
    }
  });

  renderCompletedStopsBadgesOnMap();
}

export function publishRoutesToTelemetryServer(): void {
  if (!S.routes || !S.routes.length) return;
  const serialized = S.routes.map((r: any) => ({
    id: r.id,
    color: r.color,
    option: r.option,
    visible: r.visible,
    stops: r.stops,
    alts: r.alts
  }));

  // Sincronizar rutas activas en Firebase para que los celulares de los conductores las descarguen
  const targetUrl = buildFirebaseUrl(`/rutas_activas/${getTodayDateKey()}.json`);
  if (targetUrl) {
    fetch(targetUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serialized)
    })
      .then(r => {
        if (!r.ok) handleFirebaseResponseStatus(r.status);
      })
      .catch(() => {});
  }

  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ type: 'routes:publish', routes: serialized }));
  } else {
    fetch('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routes: serialized })
    }).catch(() => {});
  }
}

export function sendTelemetryUpdate(payload: Partial<TruckTelemetry> & { truckId: string }): void {
  const existing = telemetryState.trucks.get(payload.truckId);
  const now = Date.now();
  const lat = Number(payload.lat ?? existing?.lat ?? DEPOT.lat);
  const lng = Number(payload.lng ?? existing?.lng ?? DEPOT.lng);
  const prevTrail = existing?.trail || [];
  const updatedTrail = [...prevTrail.slice(-29), { lat, lng, ts: now }];

  const optimistic: TruckTelemetry = {
    truckId: payload.truckId,
    routeId: payload.routeId ?? existing?.routeId ?? 0,
    routeName: payload.routeName || existing?.routeName || `Ruta ${(payload.routeId ?? 0) + 1}`,
    routeColor: payload.routeColor || existing?.routeColor || getRouteColorById(payload.routeId ?? 0),
    vehiclePlate: payload.vehiclePlate || existing?.vehiclePlate || `JMR-${101 + (payload.routeId ?? 0)}`,
    driverName: payload.driverName || existing?.driverName || `Conductor Ruta ${(payload.routeId ?? 0) + 1}`,
    lat,
    lng,
    speedKmh: payload.speedKmh ?? existing?.speedKmh ?? 0,
    heading: payload.heading ?? existing?.heading ?? null,
    accuracy: payload.accuracy ?? existing?.accuracy ?? 10,
    status: payload.status || existing?.status || 'en_ruta',
    statusNote: payload.statusNote ?? existing?.statusNote,
    statusSince: payload.statusSince ?? existing?.statusSince ?? now,
    currentStopIndex: payload.currentStopIndex ?? existing?.currentStopIndex ?? 0,
    totalStops: payload.totalStops ?? existing?.totalStops ?? 0,
    completedStopIds: payload.completedStopIds || existing?.completedStopIds || [],
    nextStopClient: payload.nextStopClient ?? existing?.nextStopClient,
    nextStopAddress: payload.nextStopAddress ?? existing?.nextStopAddress,
    updatedAt: now,
    source: payload.source || existing?.source || 'gps_movil',
    trail: updatedTrail,
    eventLog: payload.eventLog || existing?.eventLog || []
  };

  telemetryState.trucks.set(optimistic.truckId, optimistic);
  renderTelemetryOnMap();
  renderTelemetryPanelUI();

  // Sincronizar actualización de camión con la nube (Firebase Realtime DB)
  syncTruckToCloud(optimistic);

  if (broadcastChan) {
    try {
      broadcastChan.postMessage({ type: 'telemetry:updated', truck: optimistic });
    } catch (_e) {}
  }

  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(
      JSON.stringify({
        type: 'telemetry:update',
        payload: optimistic
      })
    );
  } else {
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(optimistic)
    }).catch(() => {});
  }
}

export function focusTruckOnMap(truckId: string): void {
  const truck = telemetryState.trucks.get(truckId);
  if (!truck) {
    toast('Este vehículo aún no reporta señal GPS activa', 'warn');
    return;
  }

  const welcomeArea = document.getElementById('welcomeUploadArea');
  const resultsSec = document.getElementById('resultsSec');
  if (welcomeArea && !welcomeArea.classList.contains('hidden')) {
    welcomeArea.classList.add('hidden');
  }
  if (resultsSec && resultsSec.classList.contains('hidden')) {
    resultsSec.classList.remove('hidden');
    if ((window as any).initMap) (window as any).initMap();
  }

  if (telemetryState.followingTruckId === truckId) {
    telemetryState.followingTruckId = null;
    toast(`Seguimiento automático desactivado para ${truck.vehiclePlate}`, 'info');
  } else {
    telemetryState.followingTruckId = truckId;
    if (S.map) {
      S.map.flyTo([truck.lat, truck.lng], 15, { animate: true, duration: 0.8 });
      const entry = truckMarkersMap.get(truckId);
      if (entry && entry.marker) {
        setTimeout(() => entry.marker.openPopup(), 450);
      }
    }
    toast(`🎯 Siguiendo en vivo a ${truck.vehiclePlate} (${truck.routeName})`, 'success');
  }

  renderTelemetryPanelUI();
}

export function copyDriverLinkForRoute(routeId: number): void {
  publishRoutesToTelemetryServer();
  const plate = `JMR-${101 + routeId}`;
  const pin = getRouteDailyPin(routeId);
  const dateKey = getTodayDateKey();
  const url = `${window.location.origin}${window.location.pathname}?modo=conductor&ruta=${routeId + 1}&placa=${encodeURIComponent(plate)}&fecha=${dateKey}&bloqueado=1`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      toast(`📲 Link del Conductor copiado. PIN de acceso: ${pin} (o placa ${plate}).`, 'success');
    }).catch(() => {
      toast(`Enlace del conductor: ${url} (PIN: ${pin})`, 'info');
    });
  } else {
    toast(`Enlace del conductor: ${url} (PIN: ${pin})`, 'info');
  }
}

// ============================================================================
// MODO EXCLUSIVO DEL CONDUCTOR Y ADAPTACIÓN RESPONSIVA MÓVIL (< 768px)
// ============================================================================

export function setMobileDriverLayout(mode: 'split' | 'list' | 'map'): void {
  telemetryState.mobileDriverLayout = mode;
  applyMobileDriverLayoutClasses();
  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 200);
}

function applyMobileDriverLayoutClasses(): void {
  const mainContainer = document.getElementById('workspaceMainContainer');
  const centerMapSec = document.getElementById('centerMapSection');
  const rightAside = document.getElementById('rightMainAside');
  const floatingReturnWrap = document.getElementById('mobileMapFloatingReturnWrap');
  const darkSidebar = document.getElementById('mainDarkSidebar');
  const routesCol = document.getElementById('routesColumnPanel');
  const coordHeader = document.getElementById('coordinatorMainHeader');
  const driverHeader = document.getElementById('driverExclusiveHeader');

  if (!telemetryState.isDriverExclusiveMode) {
    if (mainContainer) mainContainer.className = 'flex-1 flex min-h-0 overflow-hidden';
    if (centerMapSec) centerMapSec.className = 'flex-1 relative bg-[#F8FAFC] dark:bg-slate-900 flex flex-col h-full min-w-0 overflow-hidden';
    if (rightAside) rightAside.className = 'w-[295px] xl:w-[315px] shrink-0 bg-white dark:bg-slate-800 border-l border-slate-200/90 dark:border-slate-700 flex flex-col h-full overflow-hidden select-none z-20 transition-all duration-200';
    if (floatingReturnWrap) floatingReturnWrap.classList.add('hidden');
    return;
  }

  // Garantizar que en modo conductor exclusivo los paneles de despacho y edición queden 100% ocultos
  if (darkSidebar) darkSidebar.classList.add('hidden');
  if (routesCol) routesCol.classList.add('hidden');
  if (coordHeader) coordHeader.classList.add('hidden');
  if (driverHeader) driverHeader.classList.remove('hidden');

  // En modo conductor: apilar verticalmente en móvil (flex-col) y lado a lado en escritorio (md:flex-row)
  if (mainContainer) {
    mainContainer.className = 'flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden w-full';
  }

  const mode = telemetryState.mobileDriverLayout;
  const activeTabCls = 'py-1.5 px-2 rounded-lg text-[11px] font-extrabold bg-[#EA580C] text-white flex items-center justify-center gap-1 transition cursor-pointer shadow-xs';
  const inactiveTabCls = 'py-1.5 px-2 rounded-lg text-[11px] font-bold text-slate-300 hover:text-white flex items-center justify-center gap-1 transition cursor-pointer';

  (['split', 'list', 'map'] as const).forEach((k) => {
    const btn = document.getElementById(`btnMobileDriverLayout_${k}`);
    if (btn) btn.className = k === mode ? activeTabCls : inactiveTabCls;
  });

  if (mode === 'split') {
    if (centerMapSec) {
      centerMapSec.className = 'h-[36vh] sm:h-[40vh] shrink-0 md:h-full md:flex-1 relative bg-[#F8FAFC] dark:bg-slate-900 flex flex-col min-w-0 overflow-hidden border-b md:border-b-0 border-slate-700/80';
    }
    if (rightAside) {
      rightAside.className = 'w-full flex-1 md:w-[380px] xl:w-[420px] md:flex-none shrink-0 bg-white dark:bg-slate-800 md:border-l border-slate-200/90 dark:border-slate-700 flex flex-col h-full min-h-0 overflow-y-auto select-none z-20 transition-all duration-200';
    }
    if (floatingReturnWrap) floatingReturnWrap.classList.add('hidden');
  } else if (mode === 'list') {
    if (centerMapSec) {
      centerMapSec.className = 'hidden md:flex md:flex-1 relative bg-[#F8FAFC] dark:bg-slate-900 flex-col h-full min-w-0 overflow-hidden';
    }
    if (rightAside) {
      rightAside.className = 'w-full flex-1 md:w-[380px] xl:w-[420px] md:flex-none shrink-0 bg-white dark:bg-slate-800 md:border-l border-slate-200/90 dark:border-slate-700 flex flex-col h-full min-h-0 overflow-y-auto select-none z-20 transition-all duration-200';
    }
    if (floatingReturnWrap) floatingReturnWrap.classList.add('hidden');
  } else if (mode === 'map') {
    if (centerMapSec) {
      centerMapSec.className = 'w-full flex-1 relative bg-[#F8FAFC] dark:bg-slate-900 flex flex-col h-full min-w-0 overflow-hidden';
    }
    if (rightAside) {
      rightAside.className = 'hidden md:flex md:w-[380px] xl:w-[420px] shrink-0 bg-white dark:bg-slate-800 border-l border-slate-200/90 dark:border-slate-700 flex-col h-full overflow-hidden select-none z-20 transition-all duration-200';
    }
    if (floatingReturnWrap) floatingReturnWrap.classList.remove('hidden');
  }
}

export function centerDriverAssignedRoute(): void {
  if (!S.routes || !S.routes.length) return;
  const rId = telemetryState.driverSelectedRouteId;
  const routeObj = (S.routes || []).find(r => r.id === rId) || S.routes?.[0];
  if (!routeObj) return;

  const welcomeArea = document.getElementById('welcomeUploadArea');
  const resultsSec = document.getElementById('resultsSec');
  if (welcomeArea) welcomeArea.classList.add('hidden');
  if (resultsSec) resultsSec.classList.remove('hidden');
  if ((window as any).initMap) (window as any).initMap();

  S.viewMode = 'single';
  S.currentRouteIndex = routeObj.id;
  draw(routeObj);
  renderTelemetryOnMap();
  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 180);
}

export function showDriverExpiredScreen(): void {
  let modal = document.getElementById('driverExpiredModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'driverExpiredModal';
    modal.className = 'fixed inset-0 z-[99999] bg-[#0F172A] flex flex-col items-center justify-center p-6 text-center select-none';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="max-w-md w-full bg-[#1E293B] border border-rose-500/40 rounded-3xl p-8 space-y-4 shadow-2xl">
      <div class="w-16 h-16 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center text-3xl mx-auto">
        ⏳
      </div>
      <h2 class="text-xl font-black text-white">Enlace de Viaje Expirado</h2>
      <p class="text-sm text-slate-300 leading-relaxed">
        Por políticas de seguridad y protección de datos de Jamar, los enlaces de ruta móvil caducan a las 48 horas de su emisión.
      </p>
      <div class="p-3 rounded-2xl bg-slate-900/60 border border-slate-700 text-xs text-slate-400 font-medium">
        Comunícate con tu Coordinador de Despacho en <b>Cendis Siberia</b> para generar una nueva hoja de ruta activa.
      </div>
    </div>
  `;
}

export function showDriverPinGate(routeId: number, plate: string, dateKey: string): void {
  let modal = document.getElementById('driverPinGateModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'driverPinGateModal';
    modal.className = 'fixed inset-0 z-[99998] bg-[#0F172A]/95 backdrop-blur-md flex flex-col items-center justify-center p-4 select-none';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';

  modal.innerHTML = `
    <div class="max-w-sm w-full bg-[#1E293B] border border-orange-500/40 rounded-3xl p-6 sm:p-8 space-y-5 shadow-2xl text-center">
      <div class="w-14 h-14 rounded-2xl bg-[#EA580C]/20 border border-[#EA580C]/40 text-[#EA580C] flex items-center justify-center text-2xl mx-auto shadow-inner">
        🔒
      </div>
      <div>
        <span class="px-3 py-1 rounded-full text-[11px] font-extrabold bg-[#EA580C]/20 text-[#EA580C] border border-[#EA580C]/30">
          HOJA DE RUTA ${routeId + 1}
        </span>
        <h2 class="text-lg font-black text-white mt-2">Acceso Seguro de Conductor</h2>
        <p class="text-xs text-slate-400 mt-1">Placa asignada: <strong class="text-white font-mono">${esc(plate)}</strong></p>
      </div>

      <p class="text-xs text-slate-300 leading-relaxed">
        Ingresa el <b>PIN de 4 dígitos</b> entregado por Despacho para desbloquear tu hoja de entrega:
      </p>

      <form id="driverPinForm" class="space-y-3">
        <input
          id="driverPinInput"
          type="password"
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength="6"
          placeholder="••••"
          autofocus
          class="w-full text-center text-2xl tracking-[0.4em] font-mono font-bold py-3 px-4 rounded-2xl bg-slate-900 border border-slate-700 text-white placeholder-slate-600 focus:outline-none focus:border-[#EA580C] focus:ring-2 focus:ring-[#EA580C]/30 transition"
        />
        <div id="driverPinError" class="text-xs font-semibold text-rose-400 min-h-[18px]"></div>

        <button
          type="submit"
          class="w-full py-3 px-4 rounded-2xl bg-[#EA580C] hover:bg-[#D94E06] text-white font-extrabold text-sm shadow-lg shadow-orange-600/30 transition cursor-pointer flex items-center justify-center gap-2"
        >
          <span>✓</span>
          <span>Desbloquear Mi Viaje</span>
        </button>
      </form>

      <div class="text-[10px] text-slate-500 pt-2 border-t border-slate-800">
        ¿No tienes el PIN? Solicítalo a Central Cendis Siberia o introduce los números de tu placa.
      </div>
    </div>
  `;

  const form = document.getElementById('driverPinForm') as HTMLFormElement | null;
  const input = document.getElementById('driverPinInput') as HTMLInputElement | null;
  const errEl = document.getElementById('driverPinError');

  if (form && input) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const val = input.value.trim();
      const ok = verifyDriverPin(routeId, val, plate, dateKey);
      if (ok) {
        persistDriverSession(routeId, dateKey);
        modal!.style.display = 'none';
        toast('✅ Acceso validado. Hoja de viaje desbloqueada.', 'success');
        renderTelemetryPanelUI();
      } else {
        if (errEl) errEl.textContent = '❌ PIN incorrecto. Intenta con los números de tu placa o consulta a Despacho.';
        input.value = '';
        input.focus();
      }
    };
  }
}

export function enterDriverExclusiveMode(routeId?: number, lockedByUrl = false): void {
  if (typeof routeId === 'number' && routeId >= 0) {
    telemetryState.driverSelectedRouteId = routeId;
    telemetryState.driverPlate = `JMR-${101 + routeId}`;
    telemetryState.driverName = `Conductor Ruta ${routeId + 1}`;
  }
  if (lockedByUrl) {
    telemetryState.isDriverLockedByUrl = true;

    // Validación de seguridad y PIN de Viaje
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('fecha');
    const todayStr = getTodayDateKey();

    // 1. Verificar si el enlace tiene más de 48 horas de antigüedad
    if (dateParam) {
      const diffMs = Math.abs(new Date(todayStr).getTime() - new Date(dateParam).getTime());
      const diffDays = diffMs / (1000 * 3600 * 24);
      if (diffDays > 2) {
        showDriverExpiredScreen();
        return;
      }
    }

    // 2. Comprobar si ya está autenticado en la sesión del navegador
    const activeRouteId = telemetryState.driverSelectedRouteId;
    const urlPin = urlParams.get('pin');
    const targetDate = dateParam || todayStr;

    if (urlPin && verifyDriverPin(activeRouteId, urlPin, telemetryState.driverPlate, targetDate)) {
      persistDriverSession(activeRouteId, targetDate);
    } else if (!isDriverSessionAuthenticated(activeRouteId, targetDate)) {
      showDriverPinGate(activeRouteId, telemetryState.driverPlate, targetDate);
    }
  } else if (!telemetryState.isDriverLockedByUrl) {
    // Al entrar desde el panel de Administrador, activar siempre el candado de solo lectura por seguridad
    telemetryState.adminOverrideUnlocked = false;
    const checkbox = document.getElementById('adminUnlockDriverControlsCheckbox') as HTMLInputElement | null;
    if (checkbox) checkbox.checked = false;
  }

  telemetryState.isDriverExclusiveMode = true;
  telemetryState.activeRightTab = 'driver';

  // Sincronizar con los datos en vivo del camión de esta ruta (bitácora, entregas, estado)
  syncLocalDriverStateFromLiveTruck(telemetryState.driverSelectedRouteId);

  // Si aún no hay rutas cargadas en memoria, sincronizarlas desde la nube (Firebase)
  if (!S.routes || !S.routes.length) {
    const urlParams = new URLSearchParams(window.location.search);
    const targetDate = urlParams.get('fecha') || getTodayDateKey();
    showDriverRouteSyncLoader(targetDate);
    syncActiveRoutesFromCloud(targetDate).then((success) => {
      if (!success && (!S.routes || !S.routes.length)) {
        updateDriverRouteSyncLoaderNotFound(targetDate, telemetryState.driverSelectedRouteId);
      }
    });
  }

  // 1. Ocultar el Panel Oscuro Izquierdo (#mainDarkSidebar) y el Panel de Listado de Rutas (#routesColumnPanel)
  const darkSidebar = document.getElementById('mainDarkSidebar');
  const routesCol = document.getElementById('routesColumnPanel');
  const coordHeader = document.getElementById('coordinatorMainHeader');
  const driverHeader = document.getElementById('driverExclusiveHeader');
  const tabSwitcher = document.getElementById('rightSidebarTabSwitcher');
  const btnExitDriver = document.getElementById('btnExitDriverMode');
  const btnExitDriverMobile = document.getElementById('btnExitDriverModeMobile');
  const routeSelectorWrap = document.getElementById('driverRouteSelectorWrap');

  if (darkSidebar) darkSidebar.classList.add('hidden');
  if (routesCol) routesCol.classList.add('hidden');
  if (coordHeader) coordHeader.classList.add('hidden');
  if (driverHeader) driverHeader.classList.remove('hidden');
  if (tabSwitcher) tabSwitcher.classList.add('hidden');

  // Aplicar layout responsivo móvil / escritorio
  applyMobileDriverLayoutClasses();

  // Si entró con link exclusivo de conductor (?modo=conductor), ocultar botón de volver a Coordinador y selector de otra ruta
  if (telemetryState.isDriverLockedByUrl) {
    if (btnExitDriver) btnExitDriver.classList.add('hidden');
    if (btnExitDriverMobile) btnExitDriverMobile.classList.add('hidden');
    if (routeSelectorWrap) routeSelectorWrap.classList.add('hidden');
  } else {
    if (btnExitDriver) btnExitDriver.classList.remove('hidden');
    if (btnExitDriverMobile) btnExitDriverMobile.classList.remove('hidden');
    if (routeSelectorWrap) routeSelectorWrap.classList.remove('hidden');
  }

  // Mostrar únicamente el panel del Chofer en la columna derecha
  const panelControls = document.getElementById('panelMapControls');
  const panelOffice = document.getElementById('panelTelemetryOffice');
  const panelDriver = document.getElementById('panelTelemetryDriver');
  const titleEl = document.getElementById('rightSidebarHeaderTitle');

  if (panelControls) panelControls.classList.add('hidden');
  if (panelOffice) panelOffice.classList.add('hidden');
  if (panelDriver) panelDriver.classList.remove('hidden');
  if (titleEl) titleEl.textContent = `HOJA DE RUTA · RUTA ${telemetryState.driverSelectedRouteId + 1}`;

  // Dibujar en el mapa únicamente la ruta asignada al conductor
  centerDriverAssignedRoute();

  // Iniciar cronómetro visual para el estado activo del chofer
  if (!telemetryState.driverUiTickerId) {
    telemetryState.driverUiTickerId = setInterval(() => {
      if (telemetryState.isDriverExclusiveMode && telemetryState.driverStatus === 'entregando') {
        const timerEl = document.getElementById('driverDeliveringLiveTimer');
        if (timerEl) {
          timerEl.textContent = formatDurationMinSec(telemetryState.driverStatusSince);
        }
      }
    }, 1000);
  }

  if (telemetryState.driverEventLog.length === 0) {
    addDriverLogEvent(`Terminal de Ruta ${telemetryState.driverSelectedRouteId + 1} lista para monitoreo`, telemetryState.driverStatus);
  }

  renderTelemetryPanelUI();
}

export function exitDriverExclusiveMode(): void {
  telemetryState.isDriverExclusiveMode = false;
  telemetryState.adminOverrideUnlocked = false;

  const darkSidebar = document.getElementById('mainDarkSidebar');
  const routesCol = document.getElementById('routesColumnPanel');
  const coordHeader = document.getElementById('coordinatorMainHeader');
  const driverHeader = document.getElementById('driverExclusiveHeader');
  const tabSwitcher = document.getElementById('rightSidebarTabSwitcher');

  if (darkSidebar) darkSidebar.classList.remove('hidden');
  if (routesCol) routesCol.classList.remove('hidden');
  if (coordHeader) coordHeader.classList.remove('hidden');
  if (driverHeader) driverHeader.classList.add('hidden');
  if (tabSwitcher) tabSwitcher.classList.remove('hidden');

  applyMobileDriverLayoutClasses();

  switchRightTelemetryTab('office');
  renderTelemetryOnMap();

  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 220);

  toast('Vista de Coordinador restaurada', 'info');
}

export function openDriverViewForRoute(routeId: number): void {
  enterDriverExclusiveMode(routeId, false);
  toast(`🚛 Vista de Conductor (Ruta ${routeId + 1}) abierta en modo Supervisión Protegida`, 'info');
}

export function switchRightTelemetryTab(tab: 'controls' | 'office' | 'driver'): void {
  if (tab === 'driver') {
    enterDriverExclusiveMode(telemetryState.driverSelectedRouteId, false);
    return;
  }

  telemetryState.isDriverExclusiveMode = false;
  telemetryState.activeRightTab = tab;

  const btnControls = document.getElementById('tabRightControls');
  const btnOffice = document.getElementById('tabRightOffice');
  const btnDriver = document.getElementById('tabRightDriver');

  const panelControls = document.getElementById('panelMapControls');
  const panelOffice = document.getElementById('panelTelemetryOffice');
  const panelDriver = document.getElementById('panelTelemetryDriver');
  const titleEl = document.getElementById('rightSidebarHeaderTitle');

  const activeCls = 'py-1.5 px-2 rounded-full text-[11px] font-extrabold bg-[#EA580C] text-white shadow-xs transition cursor-pointer text-center truncate';
  const inactiveCls = 'py-1.5 px-2 rounded-full text-[11px] font-bold text-slate-600 dark:text-slate-300 hover:text-slate-900 transition cursor-pointer text-center truncate';

  if (btnControls) btnControls.className = tab === 'controls' ? activeCls : inactiveCls;
  if (btnOffice) btnOffice.className = tab === 'office' ? activeCls : inactiveCls;
  if (btnDriver) btnDriver.className = inactiveCls;

  if (panelControls) panelControls.classList.toggle('hidden', tab !== 'controls');
  if (panelOffice) panelOffice.classList.toggle('hidden', tab !== 'office');
  if (panelDriver) panelDriver.classList.add('hidden');

  if (titleEl) {
    if (tab === 'controls') titleEl.textContent = 'CONTROL DE MAPA & FLOTA';
    else titleEl.textContent = 'TELEMETRÍA GPS EN VIVO';
  }

  renderTelemetryPanelUI();
}

function getNextPendingStopForDriver(): { nextStop: any; nextIdx: number; stops: any[] } {
  const rId = telemetryState.driverSelectedRouteId;
  const routeObj = (S.routes || []).find(r => r.id === rId);
  const stops = routeObj ? active(routeObj) : [];
  const nextStop = stops.find((s: any) => !telemetryState.driverCompletedStops.has(s.id)) || null;
  const nextIdx = nextStop ? stops.indexOf(nextStop) : stops.length;
  return { nextStop, nextIdx, stops };
}

function buildDriverTelemetrySnapshot(): Partial<TruckTelemetry> & { truckId: string } {
  const rId = telemetryState.driverSelectedRouteId;
  const { nextStop, nextIdx, stops } = getNextPendingStopForDriver();
  const completedIds = Array.from(telemetryState.driverCompletedStops);
  const existingTruck = telemetryState.trucks.get(`ruta-${rId + 1}`);

  // Coordenadas: usar únicamente coordenadas GPS físicas reales obtenidas del dispositivo del conductor.
  // Si aún no se ha obtenido señal satelital o permisos, la unidad se reporta en la base Cendis Siberia a 0 km/h.
  // BAJO NINGUNA CIRCUNSTANCIA se usan coordenadas de paradas de clientes como posición del camión.
  const hasRealGps = telemetryState.driverLastCoords !== null;
  const lat = hasRealGps
    ? telemetryState.driverLastCoords!.lat
    : (existingTruck?.lat ?? DEPOT.lat);
  const lng = hasRealGps
    ? telemetryState.driverLastCoords!.lng
    : (existingTruck?.lng ?? DEPOT.lng);
  const speed = hasRealGps && telemetryState.driverStatus === 'en_ruta'
    ? (telemetryState.driverLastCoords!.speedKmh || 0)
    : 0;

  let note = telemetryState.driverStatusNote;
  if (!hasRealGps) {
    if (telemetryState.driverGpsHardwareState === 'disabled_on_device') {
      note = '🔴 GPS apagado en el teléfono móvil';
    } else if (telemetryState.driverGpsHardwareState === 'permission_denied') {
      note = '🔴 Permiso GPS denegado en navegador';
    } else if (telemetryState.driverIsTransmitting) {
      note = '🟡 Esperando que el conductor active el GPS en su celular';
    }
  }

  return {
    truckId: `ruta-${rId + 1}`,
    routeId: rId,
    routeName: `Ruta ${rId + 1}`,
    routeColor: getRouteColorById(rId),
    vehiclePlate: telemetryState.driverPlate.trim() || `JMR-${101 + rId}`,
    driverName: telemetryState.driverName.trim() || `Conductor Ruta ${rId + 1}`,
    lat,
    lng,
    speedKmh: speed,
    heading: hasRealGps ? telemetryState.driverLastCoords!.heading : null,
    accuracy: hasRealGps ? telemetryState.driverLastCoords!.accuracy : null,
    status: telemetryState.driverStatus,
    statusNote: note,
    statusSince: telemetryState.driverStatusSince,
    currentStopIndex: Math.max(0, nextIdx),
    totalStops: stops.length,
    completedStopIds: completedIds,
    nextStopClient: nextStop ? (nextStop.isMultiDelivery ? nextStop.clienteDisplay : nextStop.cliente) : 'Retorno Cendis Siberia',
    nextStopAddress: nextStop ? `${nextStop.direccion} (${nextStop.ciudad})` : 'Cendis Siberia',
    source: 'gps_movil',
    eventLog: [...telemetryState.driverEventLog]
  };
}

export function startDriverGpsTransmission(silentIfAlreadyRunning = false): void {
  if (isDriverActionLocked()) {
    toast('🔒 Controles bloqueados (Modo Supervisión). Marca la casilla de advertencia superior para habilitar cambios.', 'warn');
    return;
  }

  if (telemetryState.driverIsTransmitting) {
    if (!silentIfAlreadyRunning) {
      stopDriverGpsTransmission();
    }
    return;
  }

  const plateInput = document.getElementById('driverPlateInput') as HTMLInputElement | null;
  const nameInput = document.getElementById('driverNameInput') as HTMLInputElement | null;
  const routeSelect = document.getElementById('driverRouteSelect') as HTMLSelectElement | null;
  const intervalSelect = document.getElementById('driverIntervalSelect') as HTMLSelectElement | null;

  if (plateInput && plateInput.value.trim()) telemetryState.driverPlate = plateInput.value.trim().toUpperCase();
  if (nameInput && nameInput.value.trim()) telemetryState.driverName = nameInput.value.trim();
  if (routeSelect) telemetryState.driverSelectedRouteId = Number(routeSelect.value) || 0;
  if (intervalSelect) telemetryState.driverIntervalSec = Number(intervalSelect.value) || 10;

  telemetryState.driverIsTransmitting = true;
  if (telemetryState.driverStatus === 'completado') {
    telemetryState.driverStatus = 'en_ruta';
  }

  // NOTA: NO asignar coordenadas falsas de clientes al iniciar.
  // driverLastCoords permanece como null hasta que el GPS del celular envíe su primera posición real.
  if (!telemetryState.driverLastCoords) {
    telemetryState.driverStatusNote = '🟡 Solicitando señal GPS del celular...';
  }

  addDriverLogEvent(`📡 Inició viaje y transmisión GPS (${telemetryState.driverPlate}) cada ${telemetryState.driverIntervalSec}s`, telemetryState.driverStatus);

  const transmitNow = () => {
    if (!telemetryState.driverIsTransmitting) return;
    const payload = buildDriverTelemetrySnapshot();
    telemetryState.driverPacketsSent += 1;
    telemetryState.driverLastSentAt = Date.now();
    sendTelemetryUpdate(payload);
  };

  transmitNow();

  if ('geolocation' in navigator) {
    telemetryState.driverWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const wasGpsDisabled = telemetryState.driverGpsHardwareState === 'disabled_on_device' ||
                               telemetryState.driverGpsHardwareState === 'permission_denied';
        telemetryState.driverGpsHardwareState = 'active';

        const speedMs = pos.coords.speed;
        const calcSpeedKmh = speedMs !== null && speedMs !== undefined && speedMs > 0
          ? Math.round(speedMs * 3.6)
          : (telemetryState.driverStatus === 'en_ruta' ? 28 : 0);

        telemetryState.driverLastCoords = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          speedKmh: calcSpeedKmh,
          heading: pos.coords.heading,
          accuracy: pos.coords.accuracy
        };

        if (wasGpsDisabled) {
          addDriverLogEvent('🟢 Señal GPS del celular restablecida por el conductor', telemetryState.driverStatus);
          toast('🟢 Señal GPS restablecida en el dispositivo.', 'success');
        }

        transmitNow();
        renderTelemetryPanelUI();
      },
      (err) => {
        // DETECCIÓN EXACTA DEL ESTADO DEL GPS DEL TELÉFONO
        if (err.code === 2) { // POSITION_UNAVAILABLE -> El conductor apagó el GPS en su celular
          if (telemetryState.driverGpsHardwareState !== 'disabled_on_device') {
            telemetryState.driverGpsHardwareState = 'disabled_on_device';
            addDriverLogEvent('🔴 GPS del celular apagado / deshabilitado por el conductor', 'detenido');
            toast('🔴 Ubicación GPS apagada en tu celular. Enciende el GPS en los ajustes rápidos de tu teléfono.', 'error');
          }
          telemetryState.driverStatus = 'detenido';
          telemetryState.driverStatusNote = '🔴 GPS apagado en el teléfono móvil';
        } else if (err.code === 1) { // PERMISSION_DENIED -> Rechazó o revocó el permiso en el navegador
          if (telemetryState.driverGpsHardwareState !== 'permission_denied') {
            telemetryState.driverGpsHardwareState = 'permission_denied';
            addDriverLogEvent('🔴 Permiso de GPS denegado en el navegador del celular', 'detenido');
            toast('🔴 Permiso de GPS denegado. Concede permisos de ubicación al navegador para continuar.', 'error');
          }
          telemetryState.driverStatus = 'detenido';
          telemetryState.driverStatusNote = '🔴 Permiso GPS denegado en navegador';
        } else { // TIMEOUT
          if (telemetryState.driverGpsHardwareState !== 'searching') {
            telemetryState.driverGpsHardwareState = 'searching';
            addDriverLogEvent('⚠️ Buscando satélites GPS (sin señal en el celular)', 'detenido');
          }
          telemetryState.driverStatusNote = '⚠️ Buscando señal GPS satelital...';
        }

        if (telemetryState.driverLastCoords) {
          telemetryState.driverLastCoords.speedKmh = 0;
        }

        transmitNow();
        renderTelemetryPanelUI();
      },
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 10000
      }
    );
  } else {
    addDriverLogEvent('🔴 El navegador del dispositivo no soporta geolocalización', 'detenido');
  }

  telemetryState.driverIntervalId = setInterval(() => {
    transmitNow();
  }, telemetryState.driverIntervalSec * 1000);

  toast(`📡 GPS activo para Ruta ${telemetryState.driverSelectedRouteId + 1} (${telemetryState.driverPlate})`, 'success');
  renderTelemetryPanelUI();
}

export function stopDriverGpsTransmission(): void {
  if (isDriverActionLocked()) {
    toast('🔒 Controles bloqueados (Modo Supervisión). Marca la casilla de advertencia superior para habilitar cambios.', 'warn');
    return;
  }

  telemetryState.driverIsTransmitting = false;
  if (telemetryState.driverWatchId !== null && 'geolocation' in navigator) {
    navigator.geolocation.clearWatch(telemetryState.driverWatchId);
    telemetryState.driverWatchId = null;
  }
  if (telemetryState.driverIntervalId) {
    clearInterval(telemetryState.driverIntervalId);
    telemetryState.driverIntervalId = null;
  }

  // Notificar inmediatamente a Central Cendis que el GPS fue detenido
  telemetryState.driverStatus = 'detenido';
  telemetryState.driverStatusNote = '🔴 GPS apagado por el conductor';
  if (telemetryState.driverLastCoords) {
    telemetryState.driverLastCoords.speedKmh = 0;
  }
  addDriverLogEvent('🔴 GPS apagado por el conductor', 'detenido');

  const payload = buildDriverTelemetrySnapshot();
  payload.status = 'detenido';
  payload.statusNote = '🔴 GPS apagado por el conductor';
  payload.speedKmh = 0;
  sendTelemetryUpdate(payload);

  toast('Transmisión GPS detenida · Central Cendis notificada', 'info');
  renderTelemetryPanelUI();
}

// ============================================================================
// FUNCIONALIDAD REAL DE LOS 4 BOTONES OPERATIVOS DEL CONDUCTOR
// (1. En Ruta | 2. Entregando | 3. Tráfico / Pausa | 4. Fin de Ruta)
// ============================================================================

export function setDriverOperationalStatus(status: TruckTelemetry['status'], customReason?: string): void {
  if (isDriverActionLocked()) {
    toast('🔒 Controles bloqueados (Modo Supervisión). Marca la casilla de advertencia superior si necesitas modificar el viaje.', 'warn');
    return;
  }

  telemetryState.driverStatus = status;
  telemetryState.driverStatusSince = Date.now();

  const { nextStop, nextIdx, stops } = getNextPendingStopForDriver();
  const nextClientName = nextStop
    ? (nextStop.isMultiDelivery ? nextStop.clienteDisplay : nextStop.cliente)
    : 'Cendis Siberia';

  if (status === 'en_ruta') {
    telemetryState.driverStatusNote = nextStop
      ? `En tránsito a Parada #${nextIdx + 1}: ${nextClientName}`
      : 'En tránsito de retorno a Cendis Siberia';

    if (!telemetryState.driverIsTransmitting) {
      startDriverGpsTransmission(true);
    }

    addDriverLogEvent(`🟢 En Ruta: Hacia ${nextClientName}`, 'en_ruta');
    toast(`🟢 Estado actualizado: En Ruta hacia ${nextClientName}`, 'success');
  } else if (status === 'entregando') {
    telemetryState.driverStatusNote = nextStop
      ? `Descargando pedido en cliente: ${nextClientName}`
      : 'Realizando entrega en punto actual';

    if (!telemetryState.driverIsTransmitting) {
      startDriverGpsTransmission(true);
    }

    addDriverLogEvent(`📦 Inició entrega donde cliente: ${nextClientName}`, 'entregando');
    toast(`📦 Estado: Entregando muebles donde ${nextClientName} (Cronómetro activo)`, 'info');
  } else if (status === 'detenido') {
    const reason = customReason || 'Tráfico pesado / Novedad en vía';
    telemetryState.driverStatusNote = `⚠️ Novedad: ${reason}`;

    if (!telemetryState.driverIsTransmitting) {
      startDriverGpsTransmission(true);
    }

    if (telemetryState.driverLastCoords) {
      telemetryState.driverLastCoords.speedKmh = 0;
    }

    addDriverLogEvent(`⏸️ Reportó novedad a Central: ${reason}`, 'detenido');
    toast(`⏸️ Novedad enviada a Central Cendis: "${reason}"`, 'warn');
  } else if (status === 'completado') {
    const deliveredCount = telemetryState.driverCompletedStops.size;
    telemetryState.driverStatusNote = `Ruta finalizada (${deliveredCount}/${stops.length} entregas completadas)`;
    if (telemetryState.driverLastCoords) {
      telemetryState.driverLastCoords.speedKmh = 0;
    }
    addDriverLogEvent(`✅ Fin de Ruta reportado (${deliveredCount}/${stops.length} clientes entregados)`, 'completado');

    // Enviar paquete final antes de apagar el watchPosition para ahorrar batería
    const finalPayload = buildDriverTelemetrySnapshot();
    telemetryState.driverPacketsSent += 1;
    telemetryState.driverLastSentAt = Date.now();
    sendTelemetryUpdate(finalPayload);

    if (telemetryState.driverIsTransmitting) {
      stopDriverGpsTransmission();
    }
    toast(`✅ Fin de Ruta reportado a Central Cendis (${deliveredCount}/${stops.length} entregas)`, 'success');
    renderTelemetryPanelUI();
    return;
  }

  // Transmitir de inmediato el nuevo estado y bitácora a la Central y al Mapa
  const payload = buildDriverTelemetrySnapshot();
  telemetryState.driverPacketsSent += 1;
  telemetryState.driverLastSentAt = Date.now();
  sendTelemetryUpdate(payload);
}

export function setDriverPauseReason(reason: string): void {
  if (isDriverActionLocked()) {
    toast('🔒 Controles bloqueados (Modo Supervisión). Marca la casilla de advertencia superior para habilitar cambios.', 'warn');
    return;
  }
  setDriverOperationalStatus('detenido', reason);
}

export function completeCurrentStopAndContinue(): void {
  if (isDriverActionLocked()) {
    toast('🔒 Controles bloqueados (Modo Supervisión). Marca la casilla de advertencia superior para habilitar cambios.', 'warn');
    return;
  }
  const { nextStop } = getNextPendingStopForDriver();
  if (!nextStop) {
    setDriverOperationalStatus('completado');
    return;
  }
  toggleDriverStopCompleted(nextStop.id);
}

export function toggleDriverStopCompleted(stopId: number): void {
  if (isDriverActionLocked()) {
    toast('🔒 Controles bloqueados (Modo Supervisión). Marca la casilla de advertencia superior para evitar marcar entregas por error.', 'warn');
    return;
  }

  const rId = telemetryState.driverSelectedRouteId;
  const routeObj = (S.routes || []).find(r => r.id === rId);
  const stops = routeObj ? active(routeObj) : [];
  const targetStop = stops.find((x: any) => x.id === stopId) || (S.destinations || []).find(x => x.id === stopId);
  const clientLabel = targetStop
    ? (targetStop.isMultiDelivery ? targetStop.clienteDisplay : targetStop.cliente)
    : `Parada #${stopId}`;

  if (telemetryState.driverCompletedStops.has(stopId)) {
    telemetryState.driverCompletedStops.delete(stopId);
    addDriverLogEvent(`↩️ Reabrió entrega de ${clientLabel}`, telemetryState.driverStatus);
  } else {
    telemetryState.driverCompletedStops.add(stopId);
    addDriverLogEvent(`✓ Entregado cliente: ${clientLabel}`, 'en_ruta');
    toast(`✅ Pedido marcado como ENTREGADO: ${clientLabel}`, 'success');

    // Si ya entregó todos los clientes de la ruta, pasar a Fin de Ruta automáticamente
    if (stops.length > 0 && telemetryState.driverCompletedStops.size >= stops.length) {
      setDriverOperationalStatus('completado');
      return;
    } else {
      // Avanzar automáticamente a En Ruta hacia el siguiente cliente pendiente
      const { nextStop: followingStop, nextIdx } = getNextPendingStopForDriver();
      if (followingStop) {
        const nextName = followingStop.isMultiDelivery ? followingStop.clienteDisplay : followingStop.cliente;
        telemetryState.driverStatus = 'en_ruta';
        telemetryState.driverStatusSince = Date.now();
        telemetryState.driverStatusNote = `En tránsito a Parada #${nextIdx + 1}: ${nextName}`;
      }
    }
  }

  const payload = buildDriverTelemetrySnapshot();
  telemetryState.driverPacketsSent += 1;
  telemetryState.driverLastSentAt = Date.now();
  sendTelemetryUpdate(payload);
}

// ============================================================================
// TELEMETRÍA EN VIVO SOBRE RUTAS PLANIFICADAS (PRUEBA DE FLOTA EN TIEMPO REAL)
// ============================================================================
const fleetRouteCursors = new Map<number, { ptIndex: number; stopIndex: number }>();

export function toggleFleetLiveTelemetryDemo(): void {
  if (telemetryState.fleetDemoActive) {
    stopFleetLiveTelemetryDemo();
    return;
  }

  if (!S.routes || !S.routes.length) {
    toast('Primero carga un archivo Excel con tus rutas o activa la Demo en Vivo', 'warn');
    return;
  }

  telemetryState.fleetDemoActive = true;
  fleetRouteCursors.clear();

  const stepFleetTrucks = () => {
    if (!telemetryState.fleetDemoActive || !S.routes || !S.routes.length) return;

    S.routes.forEach((r: any, idx: number) => {
      const st = active(r) || [];
      if (!st.length) return;

      const cacheEntries = r._osrmCache ? Object.values(r._osrmCache) : [];
      const firstCached: any = cacheEntries[0];
      const osrmCoords: [number, number][] =
        firstCached && Array.isArray(firstCached.coordinates) && firstCached.coordinates.length > 2
          ? firstCached.coordinates
          : [[DEPOT.lat, DEPOT.lng], ...st.map((s: any) => [s.lat, s.lng] as [number, number])];

      let cursor = fleetRouteCursors.get(r.id);
      const isInitialTick = !cursor;
      if (!cursor) {
        cursor = { ptIndex: Math.min(idx * 3, Math.max(0, osrmCoords.length - 1)), stopIndex: 0 };
        fleetRouteCursors.set(r.id, cursor);
      }

      const pt = osrmCoords[cursor.ptIndex] || [DEPOT.lat, DEPOT.lng];
      const progressRatio = osrmCoords.length > 1 ? cursor.ptIndex / (osrmCoords.length - 1) : 0;
      const currentStopIdx = Math.min(st.length - 1, Math.floor(progressRatio * st.length));
      const completedIds = st.slice(0, currentStopIdx).map((s: any) => s.id);
      const nextStop = st[currentStopIdx] || st[st.length - 1];
      const nextClientName = nextStop ? (nextStop.isMultiDelivery ? nextStop.clienteDisplay : nextStop.cliente) : 'Cendis Siberia';

      const isDelivering = cursor.ptIndex > 0 && cursor.ptIndex % 9 === 0;
      const speed = isDelivering ? 0 : 28 + ((r.id * 7 + cursor.ptIndex * 3) % 24);
      const truckId = `ruta-${r.id + 1}`;
      const existingTruck = telemetryState.trucks.get(truckId);
      const prevLog = existingTruck?.eventLog ? [...existingTruck.eventLog] : [];
      const prevCompletedCount = existingTruck?.completedStopIds?.length || 0;

      if (isInitialTick && prevLog.length === 0) {
        prevLog.unshift({
          time: nowTimeStr(),
          text: `📡 Salida Cendis Siberia · En ruta hacia ${nextClientName}`,
          status: 'en_ruta'
        });
      } else if (completedIds.length > prevCompletedCount) {
        const justFinishedStop = st[completedIds.length - 1];
        const finishedName = justFinishedStop ? (justFinishedStop.isMultiDelivery ? justFinishedStop.clienteDisplay : justFinishedStop.cliente) : `Parada #${completedIds.length}`;
        prevLog.unshift({
          time: nowTimeStr(),
          text: `✓ Entregado cliente: ${finishedName}`,
          status: 'en_ruta'
        });
      } else if (isDelivering && existingTruck?.status !== 'entregando') {
        prevLog.unshift({
          time: nowTimeStr(),
          text: `📦 Descargando pedido donde ${nextClientName}`,
          status: 'entregando'
        });
      }

      if (prevLog.length > 20) prevLog.length = 20;

      sendTelemetryUpdate({
        truckId,
        routeId: r.id,
        routeName: `Ruta ${r.id + 1}`,
        routeColor: r.color || getRouteColorById(r.id),
        vehiclePlate: `JMR-${101 + r.id}`,
        driverName: [
          'Andrés Villamil',
          'Carlos Julio Pardo',
          'Miguel Ángel Díaz',
          'Jhon Jairo Mora',
          'Héctor Fabio Ruiz',
          'Wilmar Alarcón'
        ][r.id % 6],
        lat: pt[0],
        lng: pt[1],
        speedKmh: speed,
        heading: 90,
        accuracy: 6,
        status: isDelivering ? 'entregando' : 'en_ruta',
        statusNote: isDelivering ? `Descargando muebles donde ${nextClientName}` : `En tránsito hacia ${nextClientName}`,
        currentStopIndex: currentStopIdx,
        totalStops: st.length,
        completedStopIds: completedIds,
        nextStopClient: nextClientName,
        nextStopAddress: nextStop ? `${nextStop.direccion} (${nextStop.ciudad})` : 'Cendis Siberia',
        source: 'demo_gps',
        eventLog: prevLog
      });

      // Si el administrador está inspeccionando esta ruta en la vista Chofer, sincronizar su bitácora y entregas
      if (r.id === telemetryState.driverSelectedRouteId && !telemetryState.driverIsTransmitting) {
        syncLocalDriverStateFromLiveTruck(r.id);
      }

      const stepSize = Math.max(1, Math.floor(osrmCoords.length / 35));
      cursor.ptIndex = (cursor.ptIndex + stepSize) % osrmCoords.length;
    });
  };

  stepFleetTrucks();
  telemetryState.fleetDemoTimer = setInterval(stepFleetTrucks, 2800);
  switchRightTelemetryTab('office');
  if ((window as any).toggleDarkSidebar) {
    (window as any).toggleDarkSidebar(true);
  }
  toast('🛰️ Telemetría GPS y Bitácora de flota en vivo iniciadas', 'success');
  renderTelemetryPanelUI();
}

export function stopFleetLiveTelemetryDemo(): void {
  telemetryState.fleetDemoActive = false;
  if (telemetryState.fleetDemoTimer) {
    clearInterval(telemetryState.fleetDemoTimer);
    telemetryState.fleetDemoTimer = null;
  }
  toast('Simulación de telemetría de flota pausada', 'info');
  renderTelemetryPanelUI();
}

export function clearAllTelemetryTrucks(): void {
  stopFleetLiveTelemetryDemo();
  telemetryState.trucks.clear();
  telemetryState.followingTruckId = null;

  if (mapTelemetryLayer) {
    mapTelemetryLayer.clearLayers();
  }
  truckMarkersMap.clear();

  // Limpiar telemetría de hoy en Firebase Realtime Database
  const today = getTodayDateKey();
  const targetUrl = buildFirebaseUrl(`/telemetria/${today}.json`);
  if (targetUrl) {
    fetch(targetUrl, { method: 'DELETE' }).catch(() => {});
  }

  // Limpiar rutas activas de hoy en Firebase
  const routesUrl = buildFirebaseUrl(`/rutas_activas/${today}.json`);
  if (routesUrl) {
    fetch(routesUrl, { method: 'DELETE' }).catch(() => {});
  }

  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ type: 'telemetry:clear' }));
  } else {
    fetch('/api/telemetry/all', { method: 'DELETE' }).catch(() => {});
  }

  renderTelemetryOnMap();
  renderTelemetryPanelUI();
  toast('🗑️ Telemetría y camiones de prueba eliminados de memoria y de la nube', 'info');
}

// ============================================================================
// RENDERIZADO DEL PANEL DE TELEMETRÍA (CENTRAL OFICINA VS TERMINAL CONDUCTOR)
// ============================================================================

export function renderTelemetryPanelUI(): void {
  // 1. Indicador de estado WebSocket
  const wsBadge = document.getElementById('wsStatusBadge');
  if (wsBadge) {
    if (telemetryState.wsConnected) {
      wsBadge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 text-[10px] font-extrabold';
      wsBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span><span>EN VIVO</span>';
    } else {
      wsBadge.className = 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-[10px] font-bold';
      wsBadge.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span><span>SYNC</span>';
    }
  }

  // 2. Contadores en la vista Oficina
  const trucksList = Array.from(telemetryState.trucks.values());
  const now = Date.now();
  const isTruckActiveGps = (t: TruckTelemetry) => (now - (t.updatedAt || 0)) <= 35000;
  const inRouteCount = trucksList.filter(t => t.status === 'en_ruta' && isTruckActiveGps(t)).length;
  const deliveringCount = trucksList.filter(t => t.status === 'entregando').length;

  const elActiveCount = document.getElementById('telemetryActiveCount');
  if (elActiveCount) elActiveCount.textContent = String(trucksList.length);
  const elInRouteCount = document.getElementById('telemetryInRouteCount');
  if (elInRouteCount) elInRouteCount.textContent = String(inRouteCount);
  const elDeliveringCount = document.getElementById('telemetryDeliveringCount');
  if (elDeliveringCount) elDeliveringCount.textContent = String(deliveringCount);

  const btnFleetDemo = document.getElementById('btnToggleFleetTelemetryDemo');
  if (btnFleetDemo) {
    if (telemetryState.fleetDemoActive) {
      btnFleetDemo.className = 'flex-1 py-2 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer';
      btnFleetDemo.innerHTML = '<span>⏹️</span><span>Detener Prueba GPS</span>';
    } else {
      btnFleetDemo.className = 'flex-1 py-2 px-3 rounded-xl bg-[#14171F] hover:bg-slate-800 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer';
      btnFleetDemo.innerHTML = '<span>🛰️</span><span>Simular Camiones en Ruta</span>';
    }
  }

  // 3. Lista de tarjetas de seguimiento individual por Ruta / Vehículo en la vista Oficina
  const listContainer = document.getElementById('telemetryTrucksList');
  if (listContainer) {
    const plannedRoutes = S.routes || [];
    const cardsHtml: string[] = [];

    if (plannedRoutes.length > 0) {
      plannedRoutes.forEach((r: any) => {
        const truckId = `ruta-${r.id + 1}`;
        const liveTruck = telemetryState.trucks.get(truckId);
        const st = active(r) || [];
        const color = r.color || getRouteColorById(r.id);
        const isFollowing = telemetryState.followingTruckId === truckId;

        if (liveTruck) {
          const isGpsStale = liveTruck.status !== 'completado' && (now - (liveTruck.updatedAt || 0)) > 35000;
          const effectiveStatus: TruckTelemetry['status'] = isGpsStale ? 'detenido' : liveTruck.status;
          const effectiveSpeed = isGpsStale ? 0 : Math.round(liveTruck.speedKmh || 0);
          const effectiveNote = isGpsStale
            ? `🔴 Sin señal GPS (hace ${formatTimeAgo(liveTruck.updatedAt)})`
            : liveTruck.statusNote;

          const pct = liveTruck.totalStops > 0
            ? Math.min(100, Math.round(((liveTruck.completedStopIds?.length || 0) / liveTruck.totalStops) * 100))
            : 0;

          const recentLogs = Array.isArray(liveTruck.eventLog) ? liveTruck.eventLog.slice(0, 2) : [];

          cardsHtml.push(`
            <div class="p-3 rounded-2xl border ${isFollowing ? 'bg-[#1C1F26] text-white border-[#EA580C] ring-2 ring-[#EA580C]/25' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'} shadow-2xs space-y-2 transition">
              <div class="flex items-start justify-between gap-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-3 h-3 rounded-full shrink-0" style="background:${color}"></span>
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                      <span class="font-extrabold text-xs ${isFollowing ? 'text-white' : 'text-slate-900 dark:text-white'}">Ruta ${r.id + 1}</span>
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200">${esc(liveTruck.vehiclePlate)}</span>
                    </div>
                    <div class="text-[11px] ${isFollowing ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400'} truncate">👤 ${esc(liveTruck.driverName)}</div>
                  </div>
                </div>
                ${isGpsStale
                  ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-950/80 dark:text-rose-300 border border-rose-300 dark:border-rose-700"><span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>🔴 Sin GPS</span>'
                  : getStatusBadgeHtml(liveTruck.status)}
              </div>

              ${effectiveNote ? `
                <div class="px-2.5 py-1.5 rounded-xl text-[10px] font-semibold ${
                  isGpsStale || effectiveStatus === 'detenido'
                    ? 'bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30'
                    : effectiveStatus === 'entregando'
                      ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                      : effectiveStatus === 'completado'
                        ? 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30'
                        : (isFollowing ? 'bg-white/10 text-slate-200' : 'bg-slate-100 dark:bg-slate-700/60 text-slate-600 dark:text-slate-300')
                }">
                  ${esc(effectiveNote)}
                </div>
              ` : ''}

              <div class="grid grid-cols-3 gap-1.5 p-2 rounded-xl ${isFollowing ? 'bg-white/10' : 'bg-slate-50 dark:bg-slate-900/50'} text-[10px]">
                <div>
                  <span class="text-slate-400 block">Velocidad</span>
                  <strong class="${isFollowing ? 'text-white' : 'text-slate-800 dark:text-slate-200'} font-bold">${effectiveSpeed} km/h</strong>
                </div>
                <div>
                  <span class="text-slate-400 block">Precisión</span>
                  <strong class="text-emerald-600 dark:text-emerald-400 font-bold">±${Math.round(liveTruck.accuracy || 10)}m</strong>
                </div>
                <div>
                  <span class="text-slate-400 block">Señal</span>
                  <strong class="${isFollowing ? 'text-slate-200' : 'text-slate-700 dark:text-slate-300'} font-semibold">${formatTimeAgo(liveTruck.updatedAt)}</strong>
                </div>
              </div>

              <div>
                <div class="flex justify-between text-[10px] mb-1">
                  <span class="${isFollowing ? 'text-slate-300' : 'text-slate-500'} truncate">📍 Próx: <b>${esc(liveTruck.nextStopClient || 'En tránsito')}</b></span>
                  <span class="font-bold text-emerald-500 shrink-0 ml-1">${liveTruck.completedStopIds?.length || 0}/${liveTruck.totalStops || st.length}</span>
                </div>
                <div class="w-full h-1.5 rounded-full ${isFollowing ? 'bg-white/15' : 'bg-slate-100 dark:bg-slate-700'} overflow-hidden">
                  <div class="h-full rounded-full bg-emerald-500 transition-all duration-300" style="width:${pct}%"></div>
                </div>
              </div>

              ${recentLogs.length > 0 ? `
                <div class="p-2 rounded-xl ${isFollowing ? 'bg-black/30 border border-white/10' : 'bg-slate-50/90 dark:bg-slate-900/60 border border-slate-200/60 dark:border-slate-700/70'} space-y-1 text-[10px]">
                  <div class="text-[9px] font-extrabold uppercase tracking-wider ${isFollowing ? 'text-orange-300' : 'text-slate-400'}">📋 Bitácora Reciente</div>
                  ${recentLogs.map(ev => `
                    <div class="flex items-start gap-1.5 leading-tight">
                      <span class="font-mono ${isFollowing ? 'text-slate-400' : 'text-slate-400'} shrink-0">${esc(ev.time)}</span>
                      <span class="${isFollowing ? 'text-slate-200' : 'text-slate-700 dark:text-slate-200'} font-medium truncate">${esc(ev.text)}</span>
                    </div>
                  `).join('')}
                </div>
              ` : ''}

              <div class="flex items-center gap-1.5 pt-1">
                <button type="button" onclick="window.focusTruckOnMap('${truckId}')" class="flex-1 py-1.5 px-2.5 rounded-xl text-[11px] font-bold ${isFollowing ? 'bg-[#EA580C] text-white' : 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-800 dark:text-slate-100'} transition cursor-pointer flex items-center justify-center gap-1">
                  <span>🎯</span>
                  <span>${isFollowing ? 'Siguiendo' : 'Seguir en Mapa'}</span>
                </button>
                <button type="button" onclick="window.openDriverViewForRoute(${r.id})" class="py-1.5 px-2.5 rounded-xl text-[11px] font-semibold border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 ${isFollowing ? 'text-slate-200 border-white/20' : 'text-slate-600 dark:text-slate-300'} transition cursor-pointer" title="Inspeccionar hoja de ruta del conductor (modo lectura protegido)">
                  📱 Vista Chofer
                </button>
                <button type="button" onclick="window.copyDriverLinkForRoute(${r.id})" class="py-1.5 px-2 rounded-xl text-[11px] font-semibold border border-slate-200 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 ${isFollowing ? 'text-slate-200 border-white/20' : 'text-slate-600 dark:text-slate-300'} transition cursor-pointer" title="Copiar enlace para el celular del conductor">
                  🔗
                </button>
              </div>
            </div>
          `);
        } else {
          cardsHtml.push(`
            <div class="p-3 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/40 space-y-2">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-full" style="background:${color}"></span>
                  <span class="font-bold text-xs text-slate-800 dark:text-slate-200">Ruta ${r.id + 1}</span>
                  <span class="text-[10px] text-slate-400">(${st.length} paradas)</span>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-200/70 dark:bg-slate-700 text-slate-500 dark:text-slate-400">⚪ Sin señal GPS</span>
              </div>
              <div class="flex items-center gap-1.5">
                <button type="button" onclick="window.openDriverViewForRoute(${r.id})" class="flex-1 py-1.5 px-2.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-orange-50 dark:hover:bg-slate-700 text-[#EA580C] border border-orange-200 dark:border-slate-600 text-[11px] font-bold transition cursor-pointer flex items-center justify-center gap-1">
                  <span>📱</span>
                  <span>Ver Pantalla Chofer</span>
                </button>
                <button type="button" onclick="window.copyDriverLinkForRoute(${r.id})" class="py-1.5 px-2.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 text-[11px] font-semibold transition cursor-pointer" title="Copiar link exclusivo para celular del chofer">
                  🔗 Link
                </button>
              </div>
            </div>
          `);
        }
      });
    } else {
      cardsHtml.push(`
        <div class="py-8 px-3 text-center rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30 space-y-2">
          <div class="text-2xl">🛰️</div>
          <p class="text-xs font-bold text-slate-700 dark:text-slate-200">Sin rutas cargadas</p>
          <p class="text-[11px] text-slate-400 leading-relaxed">
            Carga un archivo Excel o pulsa <b>Demo en Vivo</b> para generar rutas y supervisar la flota en tiempo real.
          </p>
        </div>
      `);
    }

    listContainer.innerHTML = cardsHtml.join('');
  }

  // 3B. Renderizar Bitácora Consolidada en Vivo en el Panel de Administrador (#officeGlobalEventLog)
  const officeLogBox = document.getElementById('officeGlobalEventLog');
  const officeLogCountBadge = document.getElementById('officeEventLogCountBadge');
  if (officeLogBox) {
    const consolidatedEvents: Array<{
      routeId: number;
      routeName: string;
      plate: string;
      color: string;
      time: string;
      text: string;
    }> = [];

    trucksList.forEach((t) => {
      const color = t.routeColor || getRouteColorById(t.routeId);
      if (Array.isArray(t.eventLog)) {
        t.eventLog.forEach((ev) => {
          consolidatedEvents.push({
            routeId: t.routeId,
            routeName: t.routeName || `Ruta ${t.routeId + 1}`,
            plate: t.vehiclePlate,
            color,
            time: ev.time,
            text: ev.text
          });
        });
      }
    });

    // Si aún no hay camión en trucksList pero hay eventos locales en driverEventLog, incluirlos también
    if (consolidatedEvents.length === 0 && telemetryState.driverEventLog.length > 0) {
      const rId = telemetryState.driverSelectedRouteId;
      telemetryState.driverEventLog.forEach((ev) => {
        consolidatedEvents.push({
          routeId: rId,
          routeName: `Ruta ${rId + 1}`,
          plate: telemetryState.driverPlate,
          color: getRouteColorById(rId),
          time: ev.time,
          text: ev.text
        });
      });
    }

    // Ordenar del más reciente al más antiguo por hora HH:MM:SS
    consolidatedEvents.sort((a, b) => b.time.localeCompare(a.time));

    if (officeLogCountBadge) {
      officeLogCountBadge.textContent = `${consolidatedEvents.length} evento${consolidatedEvents.length === 1 ? '' : 's'}`;
    }

    if (consolidatedEvents.length === 0) {
      officeLogBox.innerHTML = '<div class="text-slate-400 italic py-1">Sin eventos en bitácora. Cuando un conductor inicie viaje o marque una entrega, aparecerá aquí en vivo.</div>';
    } else {
      officeLogBox.innerHTML = consolidatedEvents.slice(0, 25).map((ev) => `
        <div class="flex items-start gap-1.5 py-1 border-b border-slate-200/60 dark:border-slate-800 last:border-0 leading-snug">
          <span class="font-mono text-slate-400 shrink-0">${esc(ev.time)}</span>
          <span class="px-1.5 py-0.2 rounded text-[9px] font-extrabold text-white shrink-0" style="background:${ev.color}">R${ev.routeId + 1}</span>
          <span class="text-slate-700 dark:text-slate-200 font-medium">${esc(ev.text)}</span>
        </div>
      `).join('');
    }
  }

  // 4. Actualizar Banner de Bloqueo de Seguridad del Administrador (#adminDriverSafetyLockBanner)
  const safetyBanner = document.getElementById('adminDriverSafetyLockBanner');
  const safetyCheckbox = document.getElementById('adminUnlockDriverControlsCheckbox') as HTMLInputElement | null;
  const safetyIcon = document.getElementById('adminSafetyLockIcon');
  const safetyTitle = document.getElementById('adminSafetyLockTitle');
  const safetyDesc = document.getElementById('adminSafetyLockDescription');
  const rolePill = document.getElementById('driverRoleModePill');
  const locked = isDriverActionLocked();

  if (safetyBanner) {
    if (telemetryState.isDriverLockedByUrl) {
      // Es el conductor real desde su enlace móvil -> no mostrar advertencia de administrador
      safetyBanner.classList.add('hidden');
      if (rolePill) {
        rolePill.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        rolePill.textContent = 'Terminal Móvil Activa';
      }
    } else {
      safetyBanner.classList.remove('hidden');
      if (safetyCheckbox) safetyCheckbox.checked = telemetryState.adminOverrideUnlocked;

      if (locked) {
        safetyBanner.className = 'p-3 rounded-2xl border border-amber-300 dark:border-amber-700/80 bg-amber-50/95 dark:bg-amber-950/40 space-y-2 shadow-2xs transition';
        if (safetyIcon) safetyIcon.textContent = '🔒';
        if (safetyTitle) {
          safetyTitle.className = 'text-[11px] font-extrabold text-amber-900 dark:text-amber-200 uppercase tracking-wide';
          safetyTitle.textContent = 'Modo Supervisión Admin (Solo Lectura)';
        }
        if (safetyDesc) {
          safetyDesc.className = 'text-[10.5px] text-amber-800/90 dark:text-amber-300/90 leading-snug mt-0.5';
          safetyDesc.textContent = 'Los botones de iniciar viaje, estados y entregas están deshabilitados para evitar que por error se altere el recorrido real del transportador.';
        }
        if (rolePill) {
          rolePill.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30';
          rolePill.textContent = '🔒 Solo Lectura';
        }
      } else {
        safetyBanner.className = 'p-3 rounded-2xl border border-rose-300 dark:border-rose-700/80 bg-rose-50/95 dark:bg-rose-950/40 space-y-2 shadow-2xs transition';
        if (safetyIcon) safetyIcon.textContent = '🔓';
        if (safetyTitle) {
          safetyTitle.className = 'text-[11px] font-extrabold text-rose-900 dark:text-rose-200 uppercase tracking-wide';
          safetyTitle.textContent = 'Manipulación Manual Habilitada (Admin)';
        }
        if (safetyDesc) {
          safetyDesc.className = 'text-[10.5px] text-rose-800/90 dark:text-rose-300/90 leading-snug mt-0.5';
          safetyDesc.textContent = 'Atención: Cualquier clic en iniciar viaje, estado o marcar entrega modificará en tiempo real el viaje del conductor.';
        }
        if (rolePill) {
          rolePill.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/25 text-rose-300 border border-rose-500/40';
          rolePill.textContent = '🔓 Edición Manual';
        }
      }
    }
  }

  // 5. Actualizar Header Exclusivo del Conductor y Controles del Chofer
  const { nextStop, nextIdx, stops } = getNextPendingStopForDriver();
  const completedCount = telemetryState.driverCompletedStops.size;
  const totalStopsCount = stops.length;

  const driverHeaderTitle = document.getElementById('driverHeaderRouteTitle');
  if (driverHeaderTitle) {
    driverHeaderTitle.textContent = `Ruta ${telemetryState.driverSelectedRouteId + 1} · Camión ${telemetryState.driverPlate} (${telemetryState.driverName})`;
  }

  const driverHeaderProgress = document.getElementById('driverHeaderProgressBadge');
  if (driverHeaderProgress) {
    driverHeaderProgress.innerHTML = `<span>📦</span><span>${completedCount} / ${totalStopsCount} clientes entregados</span>`;
  }

  const driverHeaderStatus = document.getElementById('driverHeaderStatusBadge');
  if (driverHeaderStatus) {
    if (telemetryState.driverStatus === 'en_ruta') {
      driverHeaderStatus.className = 'hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/90 border border-emerald-500/50 text-emerald-300 text-xs font-bold';
      driverHeaderStatus.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>🟢 En Ruta</span>';
    } else if (telemetryState.driverStatus === 'entregando') {
      driverHeaderStatus.className = 'hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-950/90 border border-amber-500/50 text-amber-300 text-xs font-bold';
      driverHeaderStatus.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span><span>📦 Entregando en Cliente</span>';
    } else if (telemetryState.driverStatus === 'detenido') {
      driverHeaderStatus.className = 'hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-950/90 border border-rose-500/50 text-rose-300 text-xs font-bold';
      driverHeaderStatus.innerHTML = '<span class="w-2 h-2 rounded-full bg-rose-400 animate-ping"></span><span>⏸️ Tráfico / Pausa</span>';
    } else {
      driverHeaderStatus.className = 'hidden sm:inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-950/90 border border-blue-500/50 text-blue-300 text-xs font-bold';
      driverHeaderStatus.innerHTML = '<span>✅</span><span>Ruta Finalizada</span>';
    }
  }

  const routeSelect = document.getElementById('driverRouteSelect') as HTMLSelectElement | null;
  if (routeSelect) {
    const routes = S.routes || [];
    const optionsCount = routes.length || 4;
    const currentHtml = Array.from({ length: optionsCount }, (_, i) => {
      const r = routes[i];
      const stopsCount = r ? (active(r) || []).length : 0;
      const label = r ? `Ruta ${i + 1} (${stopsCount} clientes asignados)` : `Ruta ${i + 1}`;
      const selected = i === telemetryState.driverSelectedRouteId ? 'selected' : '';
      return `<option value="${i}" ${selected}>${label}</option>`;
    }).join('');
    if (routeSelect.innerHTML !== currentHtml) {
      routeSelect.innerHTML = currentHtml;
    }
    routeSelect.value = String(telemetryState.driverSelectedRouteId);
  }

  const plateInput = document.getElementById('driverPlateInput') as HTMLInputElement | null;
  if (plateInput) {
    if (document.activeElement !== plateInput) plateInput.value = telemetryState.driverPlate;
    plateInput.disabled = locked;
    plateInput.classList.toggle('opacity-60', locked);
    plateInput.classList.toggle('cursor-not-allowed', locked);
  }

  const intervalSelect = document.getElementById('driverIntervalSelect') as HTMLSelectElement | null;
  if (intervalSelect) {
    intervalSelect.disabled = locked;
    intervalSelect.classList.toggle('opacity-60', locked);
    intervalSelect.classList.toggle('cursor-not-allowed', locked);
  }

  const nameInput = document.getElementById('driverNameInput') as HTMLInputElement | null;
  if (nameInput) {
    if (document.activeElement !== nameInput) nameInput.value = telemetryState.driverName;
    nameInput.disabled = locked;
    nameInput.classList.toggle('opacity-60', locked);
    nameInput.classList.toggle('cursor-not-allowed', locked);
  }

  const btnStartDriver = document.getElementById('btnDriverStartGps') as HTMLButtonElement | null;
  if (btnStartDriver) {
    const lockStyle = locked ? ' opacity-55 cursor-not-allowed' : ' cursor-pointer';
    if (telemetryState.driverIsTransmitting) {
      btnStartDriver.className = `w-full min-h-[44px] py-3 px-4 rounded-2xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs shadow-lg shadow-rose-600/25 flex items-center justify-center gap-2 transition${lockStyle}`;
      btnStartDriver.innerHTML = `<span class="w-2 h-2 rounded-full bg-white animate-ping"></span><span>${locked ? '🔒 GPS Activo (Solo Lectura)' : 'GPS Activo · Detener Transmisión'}</span>`;
    } else {
      btnStartDriver.className = `w-full min-h-[44px] py-3 px-4 rounded-2xl bg-[#EA580C] hover:bg-[#D94E06] text-white font-extrabold text-xs shadow-lg shadow-orange-600/25 flex items-center justify-center gap-2 transition${lockStyle}`;
      btnStartDriver.innerHTML = `<span>${locked ? '🔒' : '📡'}</span><span>${locked ? 'Iniciar Viaje GPS (Bloqueado Admin)' : 'Iniciar Viaje y Transmisión GPS'}</span>`;
    }
  }

  // Estadísticas en vivo del conductor
  const driverGpsStats = document.getElementById('driverLiveGpsStats');
  if (driverGpsStats) {
    const c = telemetryState.driverLastCoords;
    const pctDone = totalStopsCount > 0 ? Math.round((completedCount / totalStopsCount) * 100) : 0;
    let gpsStatusBadgeHtml = '';
    if (telemetryState.driverIsTransmitting) {
      if (telemetryState.driverGpsHardwareState === 'disabled_on_device') {
        gpsStatusBadgeHtml = `
          <div class="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-600 dark:text-rose-300 text-xs font-bold flex items-center gap-2">
            <span>🔴</span>
            <span>Ubicación GPS apagada en el celular. Activa el GPS en los ajustes de tu teléfono.</span>
          </div>
        `;
      } else if (telemetryState.driverGpsHardwareState === 'permission_denied') {
        gpsStatusBadgeHtml = `
          <div class="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-600 dark:text-rose-300 text-xs font-bold flex items-center gap-2">
            <span>🔴</span>
            <span>Permiso de GPS no concedido. Permite la ubicación en el navegador del teléfono.</span>
          </div>
        `;
      } else if (!c) {
        gpsStatusBadgeHtml = `
          <div class="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-xs font-semibold flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-amber-500 animate-ping shrink-0"></span>
            <span>Esperando señal GPS del celular... Acepta el permiso en la pantalla de tu móvil.</span>
          </div>
        `;
      }
    }

    driverGpsStats.innerHTML = `
      <div class="space-y-2">
        ${gpsStatusBadgeHtml}
        <div class="grid grid-cols-2 gap-2 text-[11px]">
          <div class="p-2 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-700">
            <span class="text-[10px] text-slate-400 block">Coordenadas GPS</span>
            <strong class="font-mono text-slate-800 dark:text-slate-100">${c ? `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}` : (telemetryState.driverIsTransmitting ? 'Conectando...' : 'Listo para iniciar')}</strong>
          </div>
          <div class="p-2 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-700">
            <span class="text-[10px] text-slate-400 block">Señal a Central</span>
            <strong class="text-emerald-600 dark:text-emerald-400 font-bold">${telemetryState.driverPacketsSent} reportes (${telemetryState.driverIntervalSec}s)</strong>
          </div>
        </div>
        <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-slate-700">
          <div class="flex justify-between items-center text-[11px] mb-1">
            <span class="font-bold text-slate-700 dark:text-slate-200">Progreso de Viaje</span>
            <span class="font-extrabold text-emerald-600 dark:text-emerald-400">${completedCount} de ${totalStopsCount} entregados (${pctDone}%)</span>
          </div>
          <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
            <div class="h-full rounded-full bg-emerald-500 transition-all duration-300" style="width:${pctDone}%"></div>
          </div>
        </div>
      </div>
    `;
  }

  // 6. Estilo visual activo de los 4 botones de estado operativo
  const lockSuffix = locked ? ' opacity-55 cursor-not-allowed' : ' cursor-pointer';
  const statusStyles: Record<TruckTelemetry['status'], { active: string; inactive: string }> = {
    en_ruta: {
      active: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-extrabold bg-emerald-600 text-white ring-2 ring-emerald-500/30 shadow-sm flex items-center justify-center gap-1.5 transition${lockSuffix}`,
      inactive: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-semibold bg-slate-100 dark:bg-slate-700/70 text-slate-700 dark:text-slate-200 hover:bg-emerald-50 flex items-center justify-center gap-1.5 transition${lockSuffix}`
    },
    entregando: {
      active: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-extrabold bg-amber-500 text-white ring-2 ring-amber-500/30 shadow-sm flex items-center justify-center gap-1.5 transition${lockSuffix}`,
      inactive: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-semibold bg-slate-100 dark:bg-slate-700/70 text-slate-700 dark:text-slate-200 hover:bg-amber-50 flex items-center justify-center gap-1.5 transition${lockSuffix}`
    },
    detenido: {
      active: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-extrabold bg-rose-600 text-white ring-2 ring-rose-500/30 shadow-sm flex items-center justify-center gap-1.5 transition${lockSuffix}`,
      inactive: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-semibold bg-slate-100 dark:bg-slate-700/70 text-slate-700 dark:text-slate-200 hover:bg-rose-50 flex items-center justify-center gap-1.5 transition${lockSuffix}`
    },
    completado: {
      active: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-extrabold bg-blue-600 text-white ring-2 ring-blue-500/30 shadow-sm flex items-center justify-center gap-1.5 transition${lockSuffix}`,
      inactive: `min-h-[42px] py-2.5 px-2.5 rounded-xl text-[11px] font-semibold bg-slate-100 dark:bg-slate-700/70 text-slate-700 dark:text-slate-200 hover:bg-blue-50 flex items-center justify-center gap-1.5 transition${lockSuffix}`
    }
  };

  (['en_ruta', 'entregando', 'detenido', 'completado'] as const).forEach((stKey) => {
    const btn = document.getElementById(`btnDriverStatus_${stKey}`);
    if (btn) {
      btn.className = telemetryState.driverStatus === stKey
        ? statusStyles[stKey].active
        : statusStyles[stKey].inactive;
    }
  });

  // 7. Renderizar Tarjeta de Acción Dinámica del Estado Seleccionado (#driverActiveStateActionBox)
  const actionBox = document.getElementById('driverActiveStateActionBox');
  if (actionBox) {
    const nextClientLabel = nextStop ? (nextStop.isMultiDelivery ? nextStop.clienteDisplay : nextStop.cliente) : 'Retorno a Cendis Siberia';
    const nextAddrLabel = nextStop ? `${nextStop.direccion} (${nextStop.ciudad})` : 'Autopista Medellín Km 2.5';

    if (telemetryState.driverStatus === 'en_ruta') {
      actionBox.innerHTML = `
        <div class="p-3 rounded-2xl bg-emerald-50/90 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 space-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-extrabold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
              <span>🟢 EN TRÁNSITO A PRÓXIMO CLIENTE</span>
            </span>
            <span class="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">${nextStop ? `Parada #${nextIdx + 1}` : 'Retorno'}</span>
          </div>
          <div class="p-2 rounded-xl bg-white dark:bg-slate-800 border border-emerald-200/60 dark:border-slate-700">
            <div class="font-bold text-slate-900 dark:text-white truncate">${esc(nextClientLabel)}</div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">📍 ${esc(nextAddrLabel)}</div>
          </div>
          ${nextStop ? `
            <div class="grid grid-cols-2 gap-1.5">
              <a href="${getGoogleMapsNavigationUrl(nextStop)}" target="_blank" rel="noopener noreferrer" class="min-h-[44px] py-2 px-2.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-50 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 font-extrabold text-[11px] flex items-center justify-center gap-1.5 transition shadow-xs">
                <span>🧭</span><span>Navegar GPS</span>
              </a>
              <button type="button" onclick="window.setDriverOperationalStatus('entregando')" class="min-h-[40px] py-2 px-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold text-[11px] flex items-center justify-center gap-1 transition${lockSuffix}">
                <span>${locked ? '🔒' : '📦'}</span><span>Llegué al Cliente</span>
              </button>
            </div>
          ` : ''}
        </div>
      `;
    } else if (telemetryState.driverStatus === 'entregando') {
      const elapsed = formatDurationMinSec(telemetryState.driverStatusSince);
      actionBox.innerHTML = `
        <div class="p-3 rounded-2xl bg-amber-50/90 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 space-y-2.5 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-extrabold text-amber-900 dark:text-amber-300 flex items-center gap-1.5">
              <span>📦</span>
              <span>DESCARGANDO EN CLIENTE</span>
            </span>
            <span class="px-2 py-0.5 rounded-full bg-amber-200/80 dark:bg-amber-900 text-amber-900 dark:text-amber-200 font-mono font-extrabold text-[11px]">
              ⏱️ <span id="driverDeliveringLiveTimer">${elapsed}</span>
            </span>
          </div>
          <div class="p-2 rounded-xl bg-white dark:bg-slate-800 border border-amber-200/70 dark:border-slate-700">
            <div class="font-bold text-slate-900 dark:text-white truncate">${esc(nextClientLabel)}</div>
            <div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">📍 ${esc(nextAddrLabel)}</div>
            ${nextStop ? `<div class="text-[10px] font-semibold text-amber-700 dark:text-amber-400 mt-0.5">Volumen: ${(nextStop.vol || 0).toFixed(2)} m³ · Pedido: ${esc((nextStop.pedidos || []).join(', '))}</div>` : ''}
          </div>
          <button type="button" onclick="window.completeCurrentStopAndContinue()" class="w-full min-h-[42px] py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] shadow-sm flex items-center justify-center gap-1.5 transition${lockSuffix}">
            <span>${locked ? '🔒' : '✓'}</span>
            <span>Confirmar Pedido Entregado y Avanzar</span>
          </button>
        </div>
      `;
    } else if (telemetryState.driverStatus === 'detenido') {
      actionBox.innerHTML = `
        <div class="p-3 rounded-2xl bg-rose-50/90 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 space-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-extrabold text-rose-800 dark:text-rose-300 flex items-center gap-1.5">
              <span>⏸️</span>
              <span>UNIDAD EN PAUSA / NOVEDAD VIAL</span>
            </span>
            <span class="text-[10px] font-bold text-rose-600">0 km/h</span>
          </div>
          <p class="text-[11px] text-rose-700 dark:text-rose-300 font-medium">${esc(telemetryState.driverStatusNote)}</p>
          <div class="text-[10px] font-bold uppercase tracking-wider text-slate-500 pt-0.5">Selecciona motivo para informar a Central:</div>
          <div class="grid grid-cols-2 gap-1.5">
            <button type="button" onclick="window.setDriverPauseReason('🚗 Trancón / Tráfico Pesado')" class="p-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-rose-100 border border-rose-200 dark:border-slate-700 text-[10px] font-bold text-slate-700 dark:text-slate-200 text-left${lockSuffix}">
              🚗 Tráfico Pesado
            </button>
            <button type="button" onclick="window.setDriverPauseReason('🍽️ Pausa Activa / Almuerzo')" class="p-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-rose-100 border border-rose-200 dark:border-slate-700 text-[10px] font-bold text-slate-700 dark:text-slate-200 text-left${lockSuffix}">
              🍽️ Hora Almuerzo
            </button>
            <button type="button" onclick="window.setDriverPauseReason('🏢 Esperando en Portería')" class="p-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-rose-100 border border-rose-200 dark:border-slate-700 text-[10px] font-bold text-slate-700 dark:text-slate-200 text-left${lockSuffix}">
              🏢 Espera Portería
            </button>
            <button type="button" onclick="window.setDriverPauseReason('🔧 Revisión / Novedad Mecánica')" class="p-2 rounded-lg bg-white dark:bg-slate-800 hover:bg-rose-100 border border-rose-200 dark:border-slate-700 text-[10px] font-bold text-slate-700 dark:text-slate-200 text-left${lockSuffix}">
              🔧 Novedad Mecánica
            </button>
          </div>
          <button type="button" onclick="window.setDriverOperationalStatus('en_ruta')" class="w-full min-h-[40px] py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] flex items-center justify-center gap-1.5 transition mt-1${lockSuffix}">
            <span>${locked ? '🔒' : '🟢'}</span>
            <span>Reanudar Marcha (Volver a En Ruta)</span>
          </button>
        </div>
      `;
    } else {
      const pctDone = totalStopsCount > 0 ? Math.round((completedCount / totalStopsCount) * 100) : 100;
      actionBox.innerHTML = `
        <div class="p-3 rounded-2xl bg-blue-50/90 dark:bg-blue-950/40 border border-blue-300 dark:border-blue-800 space-y-2 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-extrabold text-blue-900 dark:text-blue-300 flex items-center gap-1.5">
              <span>✅</span>
              <span>RECORRIDO FINALIZADO</span>
            </span>
            <span class="px-2 py-0.5 rounded-full bg-blue-200 dark:bg-blue-900 text-blue-900 dark:text-blue-200 font-extrabold text-[10px]">${pctDone}% Cumplido</span>
          </div>
          <p class="text-[11px] text-slate-600 dark:text-slate-300">
            Se notificó a Central Cendis Siberia el cierre de la <b>Ruta ${telemetryState.driverSelectedRouteId + 1}</b> con <b>${completedCount} de ${totalStopsCount}</b> clientes entregados.
          </p>
          <button type="button" onclick="window.setDriverOperationalStatus('en_ruta')" class="w-full min-h-[40px] py-2 px-3 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-slate-700 font-bold text-[11px] transition${lockSuffix}">
            ${locked ? '🔒' : '🔄'} Reabrir Ruta y Continuar En Ruta
          </button>
        </div>
      `;
    }
  }

  // 8. Lista de clientes de la ruta asignada al conductor para marcar entregas
  const driverStopsEl = document.getElementById('driverStopsChecklist');
  if (driverStopsEl) {
    if (!stops.length) {
      driverStopsEl.innerHTML = '<div class="text-[11px] text-slate-400 text-center py-4">No hay paradas asignadas en esta ruta.</div>';
    } else {
      driverStopsEl.innerHTML = stops.map((d: any, idx: number) => {
        const done = telemetryState.driverCompletedStops.has(d.id);
        const isCurrentTarget = !done && nextStop && nextStop.id === d.id;
        return `
          <div class="p-2.5 rounded-xl border ${
            done
              ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/70'
              : isCurrentTarget
                ? 'bg-orange-50/80 dark:bg-orange-950/30 border-[#EA580C] ring-1 ring-[#EA580C]/30'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'
          } flex items-center justify-between gap-2 text-xs transition">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="w-5 h-5 rounded-full text-[10px] font-extrabold flex items-center justify-center shrink-0 ${
                  done ? 'bg-emerald-600 text-white' : isCurrentTarget ? 'bg-[#EA580C] text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
                }">${done ? '✓' : idx + 1}</span>
                <span class="font-bold ${done ? 'line-through text-slate-400' : 'text-slate-800 dark:text-slate-100'} truncate">
                  ${esc(d.isMultiDelivery ? d.clienteDisplay : d.cliente)}
                </span>
              </div>
              <div class="text-[10px] text-slate-500 dark:text-slate-400 truncate pl-6 mt-0.5">📍 ${esc(d.direccion)} (${esc(d.ciudad)})</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <a href="${getGoogleMapsNavigationUrl(d)}" target="_blank" rel="noopener noreferrer" class="min-h-[40px] px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold flex items-center justify-center gap-1" title="Navegar con Google Maps hacia este cliente">
                <span>🧭</span><span class="hidden sm:inline">GPS</span>
              </a>
              <button type="button" onclick="window.toggleDriverStopCompleted(${d.id})" class="min-h-[36px] px-2.5 py-1.5 rounded-lg text-[10px] font-extrabold ${
                done
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-[#14171F] hover:bg-[#EA580C] text-white'
              } transition${lockSuffix}" title="${locked ? 'Bloqueado en modo supervisión Admin' : 'Marcar o desmarcar entrega'}">
                ${locked ? (done ? '🔒 ✓ Entregado' : '🔒 Bloqueado') : (done ? '✓ Entregado' : 'Marcar Entrega')}
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 9. Bitácora en vivo de la ruta seleccionada (#driverEventLogBox)
  const logBox = document.getElementById('driverEventLogBox');
  if (logBox) {
    const liveRouteTruck = telemetryState.trucks.get(`ruta-${telemetryState.driverSelectedRouteId + 1}`);
    const eventsToShow =
      liveRouteTruck && Array.isArray(liveRouteTruck.eventLog) && liveRouteTruck.eventLog.length > telemetryState.driverEventLog.length
        ? liveRouteTruck.eventLog
        : telemetryState.driverEventLog;

    if (!eventsToShow || !eventsToShow.length) {
      logBox.innerHTML = '<div class="text-slate-400 italic py-1">Sin eventos registrados aún.</div>';
    } else {
      logBox.innerHTML = eventsToShow.map(item => `
        <div class="flex items-start gap-2 py-1 border-b border-slate-100 dark:border-slate-800 last:border-0">
          <span class="font-mono text-slate-400 shrink-0">${esc(item.time)}</span>
          <span class="text-slate-700 dark:text-slate-300 font-medium">${esc(item.text)}</span>
        </div>
      `).join('');
    }
  }
}

// ============================================================================
// CONEXIÓN WEBSOCKET EN TIEMPO REAL CON RECONEXIÓN AUTOMÁTICA
// ============================================================================

export function connectTelemetrySocket(): void {
  if (typeof window === 'undefined') return;

  if (!broadcastChan && 'BroadcastChannel' in window) {
    broadcastChan = new BroadcastChannel('rutasjamar_telemetry_v1');
    broadcastChan.onmessage = (ev) => {
      const data = ev.data;
      if (data && data.type === 'telemetry:updated' && data.truck) {
        telemetryState.trucks.set(data.truck.truckId, data.truck);
        if (data.truck.routeId === telemetryState.driverSelectedRouteId && !telemetryState.driverIsTransmitting) {
          syncLocalDriverStateFromLiveTruck(data.truck.routeId);
        }
        renderTelemetryOnMap();
        renderTelemetryPanelUI();
      }
    };
  }

  // Comprobar si existe un servidor WebSocket real disponible.
  // En Vercel y hosts serverless estáticos no corre un servidor WS local en /ws/telemetry.
  // Solo conectar si estamos en localhost / entorno local o si se configuró explícitamente VITE_WS_TELEMETRY_URL.
  const isLocalHost = typeof window !== 'undefined' && 
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const customWsUrl = (import.meta as any).env?.VITE_WS_TELEMETRY_URL || 
    (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.WS_TELEMETRY_URL);

  if (!isLocalHost && !customWsUrl) {
    // Modo estático en producción (Vercel): la sincronización funciona mediante BroadcastChannel y Firebase REST
    return;
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = customWsUrl || `${proto}//${window.location.host}/ws/telemetry`;

  try {
    wsClient = new WebSocket(wsUrl);

    wsClient.onopen = () => {
      telemetryState.wsConnected = true;
      if (S.routes && S.routes.length > 0) {
        publishRoutesToTelemetryServer();
      }
      renderTelemetryPanelUI();
    };

    wsClient.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'telemetry:init') {
          if (Array.isArray(msg.trucks)) {
            telemetryState.trucks.clear();
            msg.trucks.forEach((t: TruckTelemetry) => {
              telemetryState.trucks.set(t.truckId, t);
            });
            if (!telemetryState.driverIsTransmitting) {
              syncLocalDriverStateFromLiveTruck(telemetryState.driverSelectedRouteId);
            }
          }
          if (Array.isArray(msg.routes) && msg.routes.length > 0 && (!S.routes || !S.routes.length)) {
            S.routes = msg.routes;
            if (telemetryState.isDriverExclusiveMode) {
              centerDriverAssignedRoute();
            }
          }
          renderTelemetryOnMap();
          renderTelemetryPanelUI();
        } else if (msg.type === 'routes:synced' && Array.isArray(msg.routes) && msg.routes.length > 0) {
          if (!S.routes || !S.routes.length || telemetryState.isDriverExclusiveMode) {
            S.routes = msg.routes;
            if (telemetryState.isDriverExclusiveMode) {
              centerDriverAssignedRoute();
            }
            renderTelemetryPanelUI();
          }
        } else if (msg.type === 'telemetry:updated' && msg.truck) {
          telemetryState.trucks.set(msg.truck.truckId, msg.truck);
          // Sincronizar la bitácora y las entregas en la pantalla del Administrador si está viendo esa ruta
          if (msg.truck.routeId === telemetryState.driverSelectedRouteId && !telemetryState.driverIsTransmitting) {
            syncLocalDriverStateFromLiveTruck(msg.truck.routeId);
          }
          renderTelemetryOnMap();
          renderTelemetryPanelUI();
        } else if (msg.type === 'telemetry:removed' && msg.truckId) {
          telemetryState.trucks.delete(msg.truckId);
          renderTelemetryOnMap();
          renderTelemetryPanelUI();
        } else if (msg.type === 'telemetry:cleared') {
          telemetryState.trucks.clear();
          renderTelemetryOnMap();
          renderTelemetryPanelUI();
        }
      } catch (_e) {}
    };

    wsClient.onclose = () => {
      telemetryState.wsConnected = false;
      renderTelemetryPanelUI();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectTelemetrySocket(), 3500);
    };

    wsClient.onerror = () => {
      telemetryState.wsConnected = false;
    };
  } catch (_err) {
    fetch('/api/telemetry')
      .then(r => r.json())
      .then(data => {
        if (data && Array.isArray(data.trucks)) {
          data.trucks.forEach((t: TruckTelemetry) => telemetryState.trucks.set(t.truckId, t));
          if (!telemetryState.driverIsTransmitting) {
            syncLocalDriverStateFromLiveTruck(telemetryState.driverSelectedRouteId);
          }
          renderTelemetryOnMap();
          renderTelemetryPanelUI();
        }
      })
      .catch(() => {});
  }
}

export function initTelemetrySystem(): void {
  connectTelemetrySocket();

  // Detectar si se abrió mediante link directo de conductor (?modo=conductor&ruta=1&placa=JMR-101)
  const params = new URLSearchParams(window.location.search);
  const modo = params.get('modo');
  const rutaParam = params.get('ruta');
  const placaParam = params.get('placa');

  if (rutaParam) {
    const rIdx = Math.max(0, (parseInt(rutaParam, 10) || 1) - 1);
    telemetryState.driverSelectedRouteId = rIdx;
    telemetryState.driverPlate = placaParam || `JMR-${101 + rIdx}`;
    telemetryState.driverName = `Conductor Ruta ${rIdx + 1}`;
  }

  // Listeners de inputs del conductor
  const routeSelect = document.getElementById('driverRouteSelect') as HTMLSelectElement | null;
  if (routeSelect) {
    routeSelect.onchange = () => {
      const idx = Number(routeSelect.value) || 0;
      telemetryState.driverSelectedRouteId = idx;
      telemetryState.driverPlate = `JMR-${101 + idx}`;
      telemetryState.driverName = `Conductor Ruta ${idx + 1}`;
      telemetryState.driverCompletedStops.clear();
      telemetryState.driverEventLog = [];
      syncLocalDriverStateFromLiveTruck(idx);

      if (telemetryState.isDriverExclusiveMode) {
        const titleEl = document.getElementById('rightSidebarHeaderTitle');
        if (titleEl) titleEl.textContent = `HOJA DE RUTA · RUTA ${idx + 1}`;
        centerDriverAssignedRoute();
      }
      renderTelemetryPanelUI();
    };
  }

  const plateInput = document.getElementById('driverPlateInput') as HTMLInputElement | null;
  if (plateInput) {
    plateInput.oninput = () => {
      if (isDriverActionLocked()) return;
      telemetryState.driverPlate = plateInput.value.toUpperCase();
    };
  }

  const nameInput = document.getElementById('driverNameInput') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.oninput = () => {
      if (isDriverActionLocked()) return;
      telemetryState.driverName = nameInput.value;
    };
  }

  const intervalSelect = document.getElementById('driverIntervalSelect') as HTMLSelectElement | null;
  if (intervalSelect) {
    intervalSelect.onchange = () => {
      if (isDriverActionLocked()) return;
      telemetryState.driverIntervalSec = Number(intervalSelect.value) || 10;
      if (telemetryState.driverIsTransmitting) {
        stopDriverGpsTransmission();
        startDriverGpsTransmission(true);
      }
    };
  }

  if (modo === 'conductor') {
    setTimeout(() => {
      // Al entrar por URL ?modo=conductor es el transportador desde su celular -> controles desbloqueados
      enterDriverExclusiveMode(telemetryState.driverSelectedRouteId, true);
    }, 150);
  } else {
    renderTelemetryPanelUI();
  }

  // Purgar automáticamente registros viejos (> 48h) tanto en localStorage como en Firebase
  purgeOldBitacoraRecords();

  // Cargar telemetría existente desde la nube (Firebase) si está disponible
  pullTelemetryFromCloud();

  // Sondeo periódico ligero cada 20s para mantener la pantalla de oficina sincronizada en Vercel
  setInterval(() => {
    pullTelemetryFromCloud();
  }, 20000);
}

if (typeof window !== 'undefined') {
  (window as any).switchRightTelemetryTab = switchRightTelemetryTab;
  (window as any).enterDriverExclusiveMode = enterDriverExclusiveMode;
  (window as any).exitDriverExclusiveMode = exitDriverExclusiveMode;
  (window as any).centerDriverAssignedRoute = centerDriverAssignedRoute;
  (window as any).setMobileDriverLayout = setMobileDriverLayout;
  (window as any).toggleAdminDriverOverride = toggleAdminDriverOverride;
  (window as any).startDriverGpsTransmission = startDriverGpsTransmission;
  (window as any).stopDriverGpsTransmission = stopDriverGpsTransmission;
  (window as any).setDriverOperationalStatus = setDriverOperationalStatus;
  (window as any).setDriverPauseReason = setDriverPauseReason;
  (window as any).completeCurrentStopAndContinue = completeCurrentStopAndContinue;
  (window as any).toggleDriverStopCompleted = toggleDriverStopCompleted;
  (window as any).toggleFleetLiveTelemetryDemo = toggleFleetLiveTelemetryDemo;
  (window as any).clearAllTelemetryTrucks = clearAllTelemetryTrucks;
  (window as any).focusTruckOnMap = focusTruckOnMap;
  (window as any).openDriverViewForRoute = openDriverViewForRoute;
  (window as any).copyDriverLinkForRoute = copyDriverLinkForRoute;
  (window as any).renderTelemetryPanelUI = renderTelemetryPanelUI;
  (window as any).renderTelemetryOnMap = renderTelemetryOnMap;
  (window as any).publishRoutesToTelemetryServer = publishRoutesToTelemetryServer;
  (window as any).downloadBitacoraReport = downloadBitacoraReport;
  (window as any).pullTelemetryFromCloud = pullTelemetryFromCloud;
  (window as any).syncActiveRoutesFromCloud = syncActiveRoutesFromCloud;
  (window as any).getGoogleMapsNavigationUrl = getGoogleMapsNavigationUrl;
  (window as any).getFirebaseDatabaseUrl = getFirebaseDatabaseUrl;

  window.addEventListener('beforeunload', () => {
    if (telemetryState.isDriverExclusiveMode && telemetryState.driverIsTransmitting) {
      const payload = buildDriverTelemetrySnapshot();
      payload.status = 'detenido';
      payload.statusNote = '🔴 Conductor cerró navegador / desconectó terminal';
      payload.speedKmh = 0;
      sendTelemetryUpdate(payload);
    }
  });

  if (typeof navigator !== 'undefined' && 'permissions' in navigator) {
    try {
      navigator.permissions.query({ name: 'geolocation' as any }).then((p) => {
        p.onchange = () => {
          if (p.state === 'denied') {
            if (telemetryState.driverGpsHardwareState !== 'permission_denied') {
              telemetryState.driverGpsHardwareState = 'permission_denied';
              addDriverLogEvent('🔴 Permiso de GPS revocado por el conductor en el celular', 'detenido');
              telemetryState.driverStatus = 'detenido';
              telemetryState.driverStatusNote = '🔴 Permiso GPS revocado en el dispositivo';
              if (telemetryState.driverLastCoords) telemetryState.driverLastCoords.speedKmh = 0;
              const payload = buildDriverTelemetrySnapshot();
              payload.status = 'detenido';
              payload.statusNote = '🔴 Permiso GPS revocado en el dispositivo';
              payload.speedKmh = 0;
              sendTelemetryUpdate(payload);
              renderTelemetryPanelUI();
            }
          } else if (p.state === 'granted') {
            if (telemetryState.driverGpsHardwareState === 'permission_denied') {
              telemetryState.driverGpsHardwareState = 'active';
              addDriverLogEvent('🟢 Permiso de GPS concedido por el conductor en el celular', telemetryState.driverStatus);
              renderTelemetryPanelUI();
            }
          }
        };
      }).catch(() => {});
    } catch (_e) {}
  }
}
