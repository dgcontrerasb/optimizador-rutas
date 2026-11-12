import { S, toast, esc } from '../state/store';
import { DeliveryRoute, PhysicalDestination } from '../types';
import {
  getTodayDateKey,
  buildFirebaseUrl,
  publishRoutesToTelemetryServer,
  renderTelemetryPanelUI,
  renderTelemetryOnMap,
  addDriverLogEvent
} from './telemetry';
import { getAuthenticatedUser } from './auth';

const STORAGE_KEY_PREFIX = 'rutasjamar_rutas_fijadas_';

/**
 * Obtiene las rutas oficiales fijadas para la fecha indicada (por defecto hoy)
 */
export function getConfirmedDailyRoutes(dateKey?: string): DeliveryRoute[] | null {
  const d = dateKey || getTodayDateKey();
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${d}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[DailyShift] Error al leer rutas fijadas locales:', err);
  }
  return null;
}

/**
 * Verifica si las rutas del día ya fueron confirmadas y fijadas oficialmente
 */
export function isDailyRoutesConfirmed(dateKey?: string): boolean {
  if (S.isRoutesConfirmedToday) return true;
  const existing = getConfirmedDailyRoutes(dateKey);
  return Boolean(existing && existing.length > 0);
}

/**
 * Confirma y fija oficialmente las rutas del día para monitoreo y despacho
 */
export async function confirmOfficialDailyRoutes(): Promise<boolean> {
  if (!S.routes || !S.routes.length) {
    toast('No hay rutas generadas para confirmar. Primero carga un archivo Excel.', 'error');
    return false;
  }

  const today = getTodayDateKey();
  const user = getAuthenticatedUser() || 'Coordinador';
  const totalStops = S.routes.reduce((acc, r) => acc + (r.stops?.length || 0), 0);

  // 1. Guardar en almacenamiento local persistente (resiliente a reinicios, F5 y cierres de sesión)
  try {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${today}`, JSON.stringify(S.routes));
    localStorage.setItem(`${STORAGE_KEY_PREFIX}${today}_meta`, JSON.stringify({
      confirmedAt: new Date().toISOString(),
      confirmedBy: user,
      routesCount: S.routes.length,
      stopsCount: totalStops
    }));
  } catch (err) {
    console.error('[DailyShift] Error al persistir rutas en localStorage:', err);
  }

  // 2. Marcar en estado global de la aplicación
  S.isRoutesConfirmedToday = true;

  // 3. Sincronizar en Firebase Realtime Database para que los choferes descarguen la versión oficial
  publishRoutesToTelemetryServer();

  // 4. Registrar en la bitácora oficial del día
  addDriverLogEvent(
    `📋 DESPACHO OFICIAL CONFIRMADO: ${user} fijó ${S.routes.length} rutas (${totalStops} paradas) para seguimiento en vivo`,
    'en_ruta'
  );

  // 5. Refrescar interfaces
  if ((window as any).renderRoutes) (window as any).renderRoutes();
  renderTelemetryPanelUI();
  renderTelemetryOnMap();

  toast(`🚀 ¡Despacho Oficial Confirmado! Se fijaron ${S.routes.length} rutas para hoy. Enlaces de choferes habilitados.`, 'success');
  return true;
}

/**
 * Restaura automáticamente las rutas oficiales confirmadas de hoy al abrir o iniciar sesión
 */
export async function restoreConfirmedDailyRoutesOnStartup(): Promise<boolean> {
  // Si ya están en memoria, no hacer nada
  if (S.routes && S.routes.length > 0) {
    S.isRoutesConfirmedToday = isDailyRoutesConfirmed();
    return true;
  }

  const today = getTodayDateKey();

  // 1. Intentar cargar desde localStorage
  let routes = getConfirmedDailyRoutes(today);

  // 2. Si no están en localStorage (por ejemplo, abrió la sesión desde otra máquina), buscar en Firebase
  if (!routes || !routes.length) {
    const cloudUrl = buildFirebaseUrl(`/rutas_activas/${today}.json`);
    if (cloudUrl) {
      try {
        const res = await fetch(cloudUrl);
        if (res.ok) {
          const cloudData = await res.json();
          if (Array.isArray(cloudData) && cloudData.length > 0) {
            routes = cloudData;
            try {
              localStorage.setItem(`${STORAGE_KEY_PREFIX}${today}`, JSON.stringify(cloudData));
            } catch {}
          }
        }
      } catch (e) {
        console.warn('[DailyShift] No se pudieron sincronizar rutas fijadas desde Firebase:', e);
      }
    }
  }

  if (routes && routes.length > 0) {
    S.routes = routes;
    S.isRoutesConfirmedToday = true;

    // Reconstruir lista de paradas y destinos para que las estadísticas funcionen
    const allStops: PhysicalDestination[] = [];
    routes.forEach(r => {
      const st = r.stops || (r.option === 'A' ? r.alts?.a : r.alts?.b) || [];
      st.forEach((s: any) => allStops.push(s));
    });
    S.destinations = allStops;

    // Mostrar sección de resultados y ocultar bienvenida
    const welcomeArea = document.getElementById('welcomeUploadArea');
    const resultsSec = document.getElementById('resultsSec');
    if (welcomeArea) welcomeArea.classList.add('hidden');
    if (resultsSec) resultsSec.classList.remove('hidden');

    if ((window as any).initMap) (window as any).initMap();
    if ((window as any).renderRoutes) (window as any).renderRoutes();
    if (S.routes[0] && (window as any).draw) {
      S.currentRouteIndex = 0;
      (window as any).draw(S.routes[0]);
    }
    renderTelemetryPanelUI();
    renderTelemetryOnMap();

    toast(`📌 Rutas oficiales de hoy recuperadas (${routes.length} rutas fijadas). Flota lista para seguimiento.`, 'info');
    return true;
  }

  return false;
}

/**
 * Diálogo para reemplazar o editar las rutas oficiales fijadas
 */
export function replanOrUploadNewFileModal(): void {
  const modalId = 'modalConfirmReplaceDailyShift';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'fixed inset-0 z-[9999] bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4';
    document.body.appendChild(modal);
  }

  const today = getTodayDateKey();
  modal.innerHTML = `
    <div class="bg-white dark:bg-slate-800 rounded-3xl p-6 max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-700 space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl bg-amber-500/10 text-amber-600 flex items-center justify-center text-xl shrink-0">
          ⚠️
        </div>
        <div>
          <h3 class="text-sm font-bold text-slate-900 dark:text-white">Modificar Rutas Oficiales del Día</h3>
          <p class="text-xs text-slate-500">${today} · Cendis Siberia</p>
        </div>
      </div>

      <p class="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
        Ya tienes <b>${S.routes.length} rutas oficiales fijadas</b> para el monitoreo de hoy.
        Si decides modificarlas, las rutas volverán a modo <b>Borrador</b> para que puedas reordenar paradas o cargar un nuevo archivo Excel.
      </p>

      <div class="flex flex-col gap-2 pt-2">
        <button type="button" id="btnConfirmUnlockDraft" class="w-full py-2.5 px-4 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs shadow-sm transition cursor-pointer">
          ✏️ Desbloquear y Pasar a Modo Borrador
        </button>
        <button type="button" id="btnConfirmUploadNewFile" class="w-full py-2.5 px-4 rounded-xl bg-[#EA580C] hover:bg-[#D94E06] text-white font-bold text-xs shadow-sm transition cursor-pointer">
          📁 Cargar un Nuevo Archivo Excel
        </button>
        <button type="button" id="btnCancelReplaceDailyShift" class="w-full py-2.5 px-4 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 font-semibold text-xs transition cursor-pointer">
          Volver y Mantener Rutas Actuales
        </button>
      </div>
    </div>
  `;

  modal.style.display = 'flex';

  const btnUnlock = document.getElementById('btnConfirmUnlockDraft');
  if (btnUnlock) {
    btnUnlock.onclick = () => {
      S.isRoutesConfirmedToday = false;
      try {
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}${today}`);
      } catch {}
      modal!.style.display = 'none';
      if ((window as any).renderRoutes) (window as any).renderRoutes();
      renderTelemetryPanelUI();
      toast('Rutas en modo Borrador. Puedes ajustar las paradas y volver a confirmar.', 'info');
    };
  }

  const btnNewFile = document.getElementById('btnConfirmUploadNewFile');
  if (btnNewFile) {
    btnNewFile.onclick = () => {
      S.isRoutesConfirmedToday = false;
      try {
        localStorage.removeItem(`${STORAGE_KEY_PREFIX}${today}`);
      } catch {}
      modal!.style.display = 'none';
      const fileInput = document.getElementById('file') as HTMLInputElement | null;
      if (fileInput) fileInput.click();
    };
  }

  const btnCancel = document.getElementById('btnCancelReplaceDailyShift');
  if (btnCancel) {
    btnCancel.onclick = () => {
      modal!.style.display = 'none';
    };
  }
}

// Exposición global en window
if (typeof window !== 'undefined') {
  (window as any).confirmOfficialDailyRoutes = confirmOfficialDailyRoutes;
  (window as any).replanOrUploadNewFileModal = replanOrUploadNewFileModal;
  (window as any).isDailyRoutesConfirmed = isDailyRoutesConfirmed;
}
