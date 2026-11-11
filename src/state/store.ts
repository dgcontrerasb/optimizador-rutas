import { GlobalAppState } from '../types';
import { DEFAULT_COLORS } from '../config/constants';

/**
 * Almacenamiento seguro contra bloqueos de sandbox / cookies
 */
export function safeGet(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch (e) {
    return null;
  }
}

export function safeSet(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch (e) {}
}

export const S: GlobalAppState = {
  rawRows: [],
  orders: [],
  destinations: [],
  alerts: [],
  routes: [],
  stats: {},
  map: null,
  tiles: null,
  routeLayer: null,
  markers: null,
  stopMarkers: [],
  currentRouteIndex: 0,
  viewMode: 'single',
  routeViewStyle: 'completo',
  pinSize: (safeGet('rutasjamar_pin_size') as any) || 'micro',
  routeDistributionMode: (safeGet('rutasjamar_dist_mode') as any) || 'comfort',
  colors: [...DEFAULT_COLORS]
};

// Exponer en window.S para que todos los eventos del DOM y depuración tengan acceso directo
if (typeof window !== 'undefined') {
  (window as any).S = S;
}

export function toast(m: string, t: 'info' | 'warn' | 'success' | 'error' = 'info'): void {
  const c = document.getElementById('toast');
  if (!c) return;
  const e = document.createElement('div');
  e.className = (t === 'error' ? 'bg-red-600' : t === 'warn' ? 'bg-amber-500' : t === 'success' ? 'bg-green-600' : 'bg-slate-800') +
    ' text-white text-xs sm:text-sm px-4 py-2.5 rounded-xl shadow-lg pointer-events-auto transition-opacity duration-300';
  e.textContent = m;
  c.append(e);
  setTimeout(() => { e.style.opacity = '0'; setTimeout(() => e.remove(), 300); }, 4000);
}

export function toastWithAction(m: string, actionLabel: string, actionFn: () => void, t: 'info' | 'warn' | 'success' | 'error' = 'info'): void {
  const c = document.getElementById('toast');
  if (!c) return;
  const e = document.createElement('div');
  e.className = (t === 'error' ? 'bg-red-600' : t === 'warn' ? 'bg-amber-600' : t === 'success' ? 'bg-blue-600' : 'bg-slate-800') +
    ' text-white text-xs sm:text-sm px-4 py-3 rounded-2xl shadow-2xl pointer-events-auto flex items-center justify-between gap-3.5 transition-opacity duration-300 border border-white/20';

  const textSpan = document.createElement('span');
  textSpan.textContent = m;
  textSpan.className = 'font-medium leading-snug';
  e.appendChild(textSpan);

  if (actionLabel && actionFn) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'px-3 py-1.5 rounded-xl bg-white text-slate-900 font-bold text-xs hover:bg-slate-100 active:scale-95 transition shadow-sm cursor-pointer shrink-0';
    btn.textContent = actionLabel;
    btn.onclick = () => {
      e.remove();
      actionFn();
    };
    e.appendChild(btn);
  }

  c.append(e);
  setTimeout(() => { e.style.opacity = '0'; setTimeout(() => e.remove(), 300); }, 9000);
}

export function esc(x: any): string {
  const d = document.createElement('div');
  d.textContent = x || '';
  return d.innerHTML;
}

if (typeof window !== 'undefined') {
  (window as any).toast = toast;
  (window as any).toastWithAction = toastWithAction;
}
