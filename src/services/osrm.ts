import { DEPOT, OSRM_URL } from '../config/constants';
import { PhysicalDestination } from '../types';
import { S } from '../state/store';

export function isReturnDepot(): boolean {
  const el = document.getElementById('returnDepot') as HTMLInputElement | null;
  return el ? el.checked : false;
}

export function buildGoogleMapsUrl(stops: PhysicalDestination[], returnDep: boolean): string {
  if (!stops || !stops.length) return '#';
  const origin = `${DEPOT.lat},${DEPOT.lng}`;
  const lastStop = stops[stops.length - 1];
  const destination = returnDep ? `${DEPOT.lat},${DEPOT.lng}` : `${lastStop.lat},${lastStop.lng}`;

  const intermediate = returnDep ? stops : stops.slice(0, -1);
  const waypoints = intermediate.slice(0, 9).map(s => `${s.lat},${s.lng}`).join('|');

  const params = new URLSearchParams({
    api: '1',
    origin: origin,
    destination: destination,
    travelmode: 'driving'
  });
  if (waypoints) params.set('waypoints', waypoints);

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function getRouteEffectiveKm(r: any): number {
  if (!r) return 0;
  if (r.option === 'A' && r.alts && r.alts.realDa) return r.alts.realDa;
  if (r.option === 'B' && r.alts && r.alts.realDb) return r.alts.realDb;
  if (r.realKm) return r.realKm;
  if (r.alts) return r.option === 'A' ? r.alts.da : r.alts.db;
  return 0;
}

export function applyRealDistanceToRoute(
  r: any,
  distanceKm: number,
  durationMin: number,
  optKey: 'A' | 'B' | null = null,
  onOptionAutoChanged?: () => void
): void {
  if (!r || !distanceKm) return;
  const targetOpt = optKey || r.option;
  if (!r.alts) r.alts = {};
  if (targetOpt === 'A') {
    r.alts.realDa = distanceKm;
    r.alts.realDurA = durationMin;
  } else if (targetOpt === 'B') {
    r.alts.realDb = distanceKm;
    r.alts.realDurB = durationMin;
  }

  if (r.alts.realDa && r.alts.realDb) {
    r.alts.chosen = r.alts.realDa <= r.alts.realDb ? 'A' : 'B';
    if (!r._userManualOption && r.option !== r.alts.chosen) {
      r.option = r.alts.chosen;
      r.realKm = r.option === 'A' ? r.alts.realDa : r.alts.realDb;
      r.realDurationMin = r.option === 'A' ? r.alts.realDurA : r.alts.realDurB;
      if (typeof onOptionAutoChanged === 'function') {
        onOptionAutoChanged();
      }
      return;
    }
  }

  if (targetOpt === r.option) {
    r.realKm = distanceKm;
    r.realDurationMin = durationMin;
  }

  updateRouteCardKmUI(r);
}

export function updateRouteCardKmUI(r: any): void {
  const card = document.querySelector(`.route-card[data-route-id="${r.id}"]`);
  if (!card) return;
  const kmEl = card.querySelector('.route-card-km-badge');
  const km = getRouteEffectiveKm(r);
  const isReal = Boolean(r.option === 'A' ? r.alts?.realDa : r.alts?.realDb) || Boolean(r.realKm);
  if (kmEl) {
    kmEl.innerHTML = `🛣️ ${km} km ${isReal ? '<span class="text-[9px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 font-bold border border-emerald-300 dark:border-emerald-700">Vial Real</span>' : '<span class="text-[9px] text-slate-400">est.</span>'}`;
    kmEl.className = `route-card-km-badge text-[11px] font-bold ${isReal ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'} flex items-center justify-end gap-1 mt-0.5`;
  }
  const tabA = card.querySelector('button[data-o="A"]');
  if (tabA) {
    const kmA = r.alts && r.alts.realDa ? r.alts.realDa : (r.alts ? r.alts.da : 0);
    const isRealA = Boolean(r.alts && r.alts.realDa);
    tabA.innerHTML = `Opción A: ${kmA} km ${isRealA ? 'real' : 'vial'} ${r.alts && r.alts.chosen === 'A' ? '⭐' : ''}`;
  }
  const tabB = card.querySelector('button[data-o="B"]');
  if (tabB) {
    const kmB = r.alts && r.alts.realDb ? r.alts.realDb : (r.alts ? r.alts.db : 0);
    const isRealB = Boolean(r.alts && r.alts.realDb);
    tabB.innerHTML = `Opción B: ${kmB} km ${isRealB ? 'real' : 'vial'} ${r.alts && r.alts.chosen === 'B' ? '⭐' : ''}`;
  }
}

export async function syncAllRoutesRealDistance(onOptionAutoChanged?: () => void): Promise<void> {
  if (!S.routes || !S.routes.length) return;
  const returnDep = isReturnDepot();

  for (const r of S.routes as any[]) {
    r._osrmCache = r._osrmCache || {};

    for (const optKey of ['A', 'B']) {
      const st = optKey === 'A' ? (r.alts && r.alts.a) : (r.alts && r.alts.b);
      if (!st || !st.length) continue;

      const allStops = [DEPOT, ...st];
      if (returnDep) allStops.push(DEPOT);

      const cacheKey = `${optKey}_${returnDep ? 'ret' : 'noret'}_${st.map((x: any) => `${x.id}_${(x.lat || 0).toFixed(4)}_${(x.lng || 0).toFixed(4)}`).join('-')}`;

      if (r._osrmCache[cacheKey] && r._osrmCache[cacheKey].distanceKm) {
        applyRealDistanceToRoute(r, r._osrmCache[cacheKey].distanceKm, r._osrmCache[cacheKey].durationMin, optKey as any, onOptionAutoChanged);
        continue;
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
          applyRealDistanceToRoute(r, distanceKm, durationMin, optKey as any, onOptionAutoChanged);
        }
      } catch (e) {
        // En caso de fallo de red, se mantiene la distancia aproximada sin interrumpir el flujo
      }
    }
  }
}
