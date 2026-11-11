import { MAX_DEST, MAX_VOL, MIN_DEST, MIN_VOL } from '../config/constants';
import { DeliveryRoute, PhysicalDestination } from '../types';
import { esc, S, toast } from '../state/store';
import { active, alternatives, avgDistToCluster, clusterStrictZones, deduplicateFleetStops, isReturnDepot, vol } from '../services/routing';
import { buildGoogleMapsUrl, getRouteEffectiveKm, syncAllRoutesRealDistance } from '../services/osrm';
import { draw, drawAllRoutes } from '../map/leafletMap';
import { classifyZone, isZoneCompatible, normalizeInsensitive } from '../config/zones';
import { withJamarLoader } from './loader';

export function getZoneBadge(zone: string): string {
  switch (zone) {
    case 'SABANA_OCCIDENTE':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">Sabana Occidente</span>';
    case 'SABANA_NORTE':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300">Sabana Norte</span>';
    case 'SOACHA_SUR':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300">Soacha / Sur</span>';
    case 'BOGOTA_NORTE':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300">Bogotá Norte</span>';
    case 'BOGOTA_OCCIDENTE':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300">Bogotá Occidente</span>';
    case 'BOGOTA_SUR':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">Bogotá Sur</span>';
    case 'BOGOTA_CENTRO_ORIENTE':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">Centro / Oriente</span>';
    case 'BOGOTA_SUR_ALTO':
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">Sur Montaña</span>';
    default:
      return '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300">Bogotá Urbana</span>';
  }
}

export function getRouteDominantZone(stops: PhysicalDestination[]): string {
  if (!stops || !stops.length) return '';
  const counts: Record<string, number> = {};
  stops.forEach(s => { counts[s.zone] = (counts[s.zone] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0] ? sorted[0][0] : 'BOGOTA_OCCIDENTE';
}

export function renderRoutes(): void {
  const back = isReturnDepot();

  const countBadge = document.getElementById('routesCountBadge');
  if (countBadge && S.routes && S.routes.length) {
    const visibleCount = S.routes.filter(r => r.visible !== false).length;
    countBadge.textContent = `${visibleCount}/${S.routes.length} visibles`;
    countBadge.classList.remove('hidden');
  }

  const allBtn = document.getElementById('btnViewAllRoutes');
  if (allBtn) {
    allBtn.onclick = () => {
      const anyChecked = (S.routes || []).some(r => r.visible !== false);
      if (!anyChecked) {
        (S.routes || []).forEach(r => { r.visible = true; });
        renderRoutes();
      }
      drawAllRoutes();
    };
    if (S.viewMode === 'all') {
      allBtn.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-[#EA580C] text-white shadow-xs transition cursor-pointer';
    } else {
      allBtn.className = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-600 shadow-2xs transition cursor-pointer';
    }
  }

  const replanBtn = document.getElementById('btnReplanRoutes');
  if (replanBtn) {
    replanBtn.onclick = () => replanRoutes();
  }

  const mapBarBtn = document.getElementById('btnViewAllRoutesMapBar');
  if (mapBarBtn) {
    if (S.viewMode === 'all') {
      mapBarBtn.className = 'w-full py-2.5 px-4 rounded-full bg-[#EA580C] text-white text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition cursor-pointer';
    } else {
      mapBarBtn.className = 'w-full py-2.5 px-4 rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center justify-center gap-2 shadow-2xs transition cursor-pointer';
    }
  }

  const statREl = document.querySelector('#statR div');
  if (statREl && S.routes) {
    statREl.textContent = String(S.routes.length);
  }

  const routesContainer = document.getElementById('routes');
  if (!routesContainer) return;

  routesContainer.innerHTML = S.routes.map((r: any) => {
    r.color = S.colors[r.id % S.colors.length];
    const st = active(r);
    const isAct = (S.viewMode !== 'all') && (r.id === S.currentRouteIndex);
    const dominantZone = getRouteDominantZone(st);
    const isUnderMin = st.length < MIN_DEST && vol(st) < MIN_VOL;
    const gmapsUrl = buildGoogleMapsUrl(st, back);
    const isChecked = r.visible !== false;
    const volTotal = vol(st);
    const volPct = Math.min(100, Math.round((volTotal / MAX_VOL) * 100));
    const volColor = volTotal > MAX_VOL ? 'bg-red-500' : (volTotal >= 11 && volTotal <= 14) ? 'bg-emerald-500' : 'bg-blue-600';
    const volTextColor = isAct ? 'text-emerald-400' : (volTotal > MAX_VOL ? 'text-red-500' : (volTotal >= 11 && volTotal <= 14) ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400');

    const effectiveKm = getRouteEffectiveKm(r);
    const isRealKm = Boolean(r.option === 'A' ? r.alts?.realDa : r.alts?.realDb) || Boolean(r.realKm);
    const kmA = r.alts && r.alts.realDa ? r.alts.realDa : (r.alts ? r.alts.da : 0);
    const isRealA = Boolean(r.alts && r.alts.realDa);
    const kmB = r.alts && r.alts.realDb ? r.alts.realDb : (r.alts ? r.alts.db : 0);
    const isRealB = Boolean(r.alts && r.alts.realDb);

    return `
      <div class="route-card p-4 rounded-[16px] border ${isAct ? 'border-brand-500 ring-2 ring-brand-500/20 active-fleetlog-card' : 'border-slate-200 dark:border-slate-700'} bg-white dark:bg-slate-800 shadow-xs transition cursor-pointer" data-r="${r.id}" data-route-id="${r.id}">
        <div class="flex justify-between items-start flex-wrap gap-2">
          <div class="flex items-center gap-2.5">
            <input type="checkbox" class="route-checkbox w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-brand-600 focus:ring-brand-500 cursor-pointer shrink-0" data-r="${r.id}" ${isChecked ? 'checked' : ''} title="Mostrar u ocultar Ruta ${r.id + 1} en el mapa">
            <span class="w-3.5 h-3.5 rounded-full shrink-0" style="background:${r.color}"></span>
            <div>
              <b class="text-sm font-bold text-slate-900 dark:text-white">Ruta ${r.id + 1}</b>
              <div class="mt-0.5 flex items-center gap-1.5 flex-wrap">
                ${getZoneBadge(dominantZone)}
                ${isUnderMin ? '<span class="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300 border border-amber-300 dark:border-amber-800">⚠️ Bajo mínimo</span>' : ''}
              </div>
            </div>
          </div>
          <div class="text-right">
            <span class="text-xs font-semibold ${volTotal > MAX_VOL || st.length > MAX_DEST ? 'text-red-600' : (isAct ? 'text-slate-300' : 'text-slate-600 dark:text-slate-300')}">
              ${st.length}/${MAX_DEST} paradas
            </span>
            <div class="route-card-km-badge text-[11px] font-bold ${isRealKm ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'} flex items-center justify-end gap-1 mt-0.5" title="Kilometraje vial real por la red de calles">
              🛣️ ${effectiveKm} km ${isRealKm ? '<span class="text-[9px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 font-bold border border-emerald-300 dark:border-emerald-700">Vial Real</span>' : '<span class="text-[9px] text-slate-400">est.</span>'}
            </div>
          </div>
        </div>

        <div class="mt-2.5">
          <div class="flex justify-between items-center text-[11px] mb-1 font-medium">
            <span class="${isAct ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}">Capacidad m³:</span>
            <span class="font-bold ${volTextColor}">${volTotal.toFixed(2)} / ${MAX_VOL} m³ (${volPct}%)</span>
          </div>
          <div class="w-full ${isAct ? 'bg-white/10' : 'bg-slate-100 dark:bg-slate-700/80'} rounded-full h-1.5 overflow-hidden">
            <div class="${volColor} h-1.5 rounded-full transition-all duration-300" style="width: ${volPct}%"></div>
          </div>
        </div>

        <div class="flex gap-2 my-2.5">
          <button class="tab flex-1 text-center ${r.option === 'A' ? 'active' : ''}" data-o="A">
            Opción A: ${kmA} km ${isRealA ? 'real' : 'vial'} ${r.alts && r.alts.chosen === 'A' ? '⭐' : ''}
          </button>
          <button class="tab flex-1 text-center ${r.option === 'B' ? 'active' : ''}" data-o="B">
            Opción B: ${kmB} km ${isRealB ? 'real' : 'vial'} ${r.alts && r.alts.chosen === 'B' ? '⭐' : ''}
          </button>
        </div>

        <div class="mb-2 flex items-center justify-between gap-2">
          <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="open-gmaps-btn inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/70 dark:hover:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700 transition">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
            Abrir en Google Maps
          </a>
          <span class="text-[11px] ${isAct ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'}">Salida: Siberia</span>
        </div>

        <ul class="drop space-y-1.5 mt-2 min-h-[30px]" data-r="${r.id}">
          ${st.map((d: any, i: number) => {
            const isMulti = d.isMultiDelivery && d.entregas && d.entregas.length > 1;
            return `
            <li draggable="true" data-id="${d.id}" data-cliente="${esc(d.cliente)}" class="stop-item-card p-2.5 rounded-xl ${isAct ? 'bg-white/10 border-white/15' : 'bg-slate-50 dark:bg-slate-700/60 border-slate-200/70 dark:border-slate-600'} border text-xs cursor-pointer hover:border-brand-500 hover:shadow-xs transition" title="Haz clic para ver y centrar esta parada en el mapa">
              <div class="flex justify-between items-start gap-2">
                <div class="min-w-0 flex-1">
                  <div class="font-medium ${isAct ? 'text-white' : 'text-slate-800 dark:text-slate-200'} flex items-center gap-1.5 flex-wrap">
                    <strong class="shrink-0">${i + 1}.</strong>
                    <span class="client-name font-semibold truncate">${esc(isMulti ? d.clienteDisplay : d.cliente)}</span>
                    ${isMulti ? `<span class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30">🏢 ${d.entregas.length} entregas</span>` : ''}
                  </div>
                  <div class="text-[11px] ${isAct ? 'text-slate-400' : 'text-slate-500 dark:text-slate-400'} truncate mt-0.5">
                    📍 ${esc(d.direccion)} (${esc(d.ciudad)})
                  </div>
                  ${isMulti ? `
                    <div class="mt-1.5 space-y-1 pt-1.5 border-t ${isAct ? 'border-white/10' : 'border-slate-200/60 dark:border-slate-600/60'}">
                      ${d.entregas.map((e: any) => `
                        <div class="text-[10px] flex items-center justify-between text-slate-600 dark:text-slate-300 bg-black/5 dark:bg-white/5 rounded px-1.5 py-0.5">
                          <span class="truncate">👤 <b>${esc(e.cliente)}</b> ${e.complemento ? `· <span class="text-amber-600 dark:text-amber-400 font-medium">🏢 ${esc(e.complemento)}</span>` : ''}</span>
                          <span class="font-mono tabular-nums shrink-0 ml-1 text-emerald-600 dark:text-emerald-400 font-bold">${e.vol.toFixed(2)} m³</span>
                        </div>
                      `).join('')}
                    </div>
                  ` : ''}
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button type="button" class="stop-reassign-btn p-1 text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 rounded hover:bg-indigo-50 dark:hover:bg-indigo-950/60 transition cursor-pointer font-bold text-xs" title="Reasignar parada a otra ruta" data-id="${d.id}" data-r="${r.id}">
                    ⇄
                  </button>
                  <a href="https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}&travelmode=driving&dir_action=navigate" target="_blank" rel="noopener noreferrer" class="stop-nav-btn p-1.5 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-950/60 transition cursor-pointer" title="Navegar a esta parada con Google Maps (GPS)">
                    🧭
                  </a>
                  <button type="button" class="stop-edit-btn p-1 text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 rounded hover:bg-slate-200 dark:hover:bg-slate-600 transition cursor-pointer" title="Corregir ubicación de esta parada" data-id="${d.id}">
                    ✏️
                  </button>
                  <span class="font-bold ${isAct ? 'text-emerald-400' : 'text-brand-600 dark:text-blue-400'}">${d.vol.toFixed(2)} m³</span>
                </div>
              </div>
            </li>
          `;}).join('')}
        </ul>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.route-checkbox').forEach((cb: any) => {
    cb.onclick = (e: MouseEvent) => { e.stopPropagation(); };
    cb.onchange = (e: Event) => {
      e.stopPropagation();
      const rId = +cb.dataset.r;
      const r = S.routes.find(x => x.id === rId);
      if (!r) return;
      r.visible = cb.checked;

      if (countBadge && S.routes) {
        const visibleCount = S.routes.filter(rt => rt.visible !== false).length;
        countBadge.textContent = `${visibleCount}/${S.routes.length} visibles`;
      }

      if (S.viewMode === 'all') {
        drawAllRoutes();
      } else {
        if (r.id === S.currentRouteIndex) {
          if (!r.visible) {
            drawAllRoutes();
          } else {
            draw(r);
          }
        } else {
          drawAllRoutes();
        }
      }
    };
  });

  document.querySelectorAll('.stop-reassign-btn').forEach((btn: any) => {
    btn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      openReassignModal(+btn.dataset.id, +btn.dataset.r);
    };
  });

  document.querySelectorAll('.stop-edit-btn').forEach((btn: any) => {
    btn.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      if ((window as any).openEditLocationModal) {
        (window as any).openEditLocationModal(+btn.dataset.id);
      }
    };
  });

  document.querySelectorAll('.route-card').forEach((c: any) => {
    c.onclick = (e: any) => {
      const r = S.routes.find(x => x.id == c.dataset.r);
      if (!r) return;
      if (e.target.closest('.stop-reassign-btn')) return;
      if (e.target.closest('.stop-edit-btn')) return;
      if (e.target.closest('.route-checkbox')) return;
      if (e.target.closest('.open-gmaps-btn')) return;
      if (e.target.closest('.stop-nav-btn')) return;

      if (e.target.closest('.tab')) {
        r.option = e.target.closest('.tab').dataset.o;
        r._userManualOption = true;
        r.realKm = r.option === 'A' ? (r.alts?.realDa || null) : (r.alts?.realDb || null);
        r.realDurationMin = r.option === 'A' ? (r.alts?.realDurA || null) : (r.alts?.realDurB || null);
        renderRoutes();
        if (S.viewMode === 'all') {
          drawAllRoutes();
        } else {
          draw(r);
        }
      } else if (!e.target.closest('li')) {
        r.visible = true;
        S.currentRouteIndex = r.id;
        S.viewMode = 'single';
        renderRoutes();
        draw(r);
      }
    };
  });

  document.querySelectorAll('.drop').forEach((z: any) => {
    z.ondragover = (e: DragEvent) => { e.preventDefault(); z.classList.add('drag-over'); };
    z.ondragleave = () => z.classList.remove('drag-over');
    z.ondrop = (e: DragEvent) => {
      e.preventDefault();
      z.classList.remove('drag-over');
      if (e.dataTransfer) {
        const id = JSON.parse(e.dataTransfer.getData('text/plain'));
        move(+id, +z.dataset.r);
      }
    };
  });

  document.querySelectorAll('li[draggable]').forEach((x: any) => {
    x.ondragstart = (e: DragEvent) => {
      if (e.dataTransfer) e.dataTransfer.setData('text/plain', x.dataset.id);
    };
    x.onclick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.stop-edit-btn') || (e.target as HTMLElement).closest('.stop-nav-btn') || (e.target as HTMLElement).closest('.stop-reassign-btn')) return;
      e.stopPropagation();
      const destId = +x.dataset.id;
      focusDestinationOnMap(destId);
    };
  });

  applyClientSearchFilter();
  if ((window as any).renderTelemetryPanelUI) (window as any).renderTelemetryPanelUI();
}

export function focusDestinationOnMap(destId: number): void {
  const d = S.destinations.find(x => x.id === destId);
  if (!d || !Number.isFinite(d.lat) || !Number.isFinite(d.lng) || !S.map) {
    toast('Esta parada aún no tiene coordenadas válidas', 'warn');
    return;
  }

  const parentRoute = (S.routes || []).find(r => (active(r) || []).some(x => x.id === destId));
  if (parentRoute && S.currentRouteIndex !== parentRoute.id) {
    parentRoute.visible = true;
    S.currentRouteIndex = parentRoute.id;
    S.viewMode = 'single';
    renderRoutes();
    draw(parentRoute, { preserveView: true });
  }

  const existingMarker = (S.stopMarkers || []).find(m => m._stopData && m._stopData.destination && m._stopData.destination.id === destId);
  const targetLatLng = existingMarker ? existingMarker.getLatLng() : [d.lat, d.lng];

  S.map.flyTo(targetLatLng, 16, { animate: true, duration: 0.8 });

  setTimeout(() => {
    const marker = (S.stopMarkers || []).find(m => m._stopData && m._stopData.destination && m._stopData.destination.id === destId);
    if (marker) {
      marker.openPopup();
    }
  }, 450);

  document.querySelectorAll('li[data-id]').forEach(el => el.classList.remove('ring-2', 'ring-brand-500'));
  const activeLi = document.querySelector(`li[data-id="${destId}"]`);
  if (activeLi) {
    activeLi.classList.add('ring-2', 'ring-brand-500');
    setTimeout(() => activeLi.classList.remove('ring-2', 'ring-brand-500'), 3000);
  }
}

export function applyClientSearchFilter(searchTerm?: string): void {
  const searchInput = document.getElementById('clientSearchInput') as HTMLInputElement | null;
  const rawQuery = searchTerm !== undefined ? searchTerm : (searchInput ? searchInput.value : '');
  const q = normalizeInsensitive(rawQuery);
  const clearBtn = document.getElementById('clearClientSearchBtn');
  const countEl = document.getElementById('searchResultsCount');

  if (!q) {
    if (clearBtn) clearBtn.classList.add('hidden');
    if (countEl) {
      countEl.classList.add('hidden');
      countEl.textContent = '';
    }
    document.querySelectorAll('#routes .route-card').forEach(card => card.classList.remove('hidden'));
    document.querySelectorAll('#routes .drop li').forEach(li => {
      li.classList.remove('hidden');
      li.classList.remove('ring-1', 'ring-blue-500/70', 'bg-blue-50/10');
    });
    return;
  }

  if (clearBtn) clearBtn.classList.remove('hidden');

  let totalMatches = 0;
  const cards = document.querySelectorAll('#routes .route-card');
  cards.forEach(card => {
    const lis = card.querySelectorAll('.drop li');
    let cardMatches = 0;
    lis.forEach(li => {
      const clientText = `${(li as HTMLElement).dataset.cliente || ''} ${li.textContent || ''}`;
      const match = normalizeInsensitive(clientText).includes(q);
      if (match) {
        li.classList.remove('hidden');
        li.classList.add('ring-1', 'ring-orange-500/70', 'bg-orange-50/10');
        cardMatches++;
        totalMatches++;
      } else {
        li.classList.add('hidden');
        li.classList.remove('ring-1', 'ring-orange-500/70', 'bg-orange-50/10');
      }
    });

    if (cardMatches > 0) {
      card.classList.remove('hidden');
    } else {
      card.classList.add('hidden');
    }
  });

  if (countEl) {
    countEl.classList.remove('hidden');
    countEl.textContent = totalMatches === 1
      ? '1 cliente encontrado'
      : `${totalMatches} clientes encontrados`;
  }
}

export function initClientSearchListeners(): void {
  const searchInput = document.getElementById('clientSearchInput') as HTMLInputElement | null;
  const clearBtn = document.getElementById('clearClientSearchBtn');

  if (searchInput) {
    searchInput.oninput = (e: any) => {
      applyClientSearchFilter(e.target.value);
    };
    searchInput.onkeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        applyClientSearchFilter('');
      }
    };
  }

  if (clearBtn) {
    clearBtn.onclick = () => {
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      applyClientSearchFilter('');
    };
  }
}

let reassignDestId: number | null = null;
let reassignCurrentRouteId: number | null = null;
let reassignTargetRouteId: number | null = null;

export function openReassignModal(destId: number, currentRouteId = -1): void {
  destId = +destId;
  const d = S.destinations.find(x => x.id === destId);
  if (!d) {
    toast('No se encontró información de la parada', 'error');
    return;
  }

  if ((currentRouteId === undefined || currentRouteId === null || currentRouteId < 0) && S.routes) {
    for (const r of S.routes) {
      if (active(r).some(s => s.id === destId)) {
        currentRouteId = r.id;
        break;
      }
    }
  }

  reassignDestId = destId;
  reassignCurrentRouteId = currentRouteId;
  reassignTargetRouteId = null;

  const modal = document.getElementById('reassignModal');
  if (!modal) return;

  const currentRoute = S.routes ? S.routes.find(r => r.id === currentRouteId) : null;
  const currentStops = currentRoute ? active(currentRoute) : [];

  const clientEl = document.getElementById('reassignClientName');
  if (clientEl) {
    clientEl.textContent = `${(d as any).isMultiDelivery ? (d as any).clienteDisplay : d.cliente} (ID: ${d.id})`;
  }

  const infoEl = document.getElementById('reassignStopCurrentInfo');
  if (infoEl) {
    infoEl.innerHTML = `
      <div class="flex items-center justify-between pb-1.5 mb-1.5 border-b border-slate-200 dark:border-slate-600">
        <span class="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
          ${currentRoute ? `<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${currentRoute.color}"></span> Ruta ${currentRoute.id + 1}` : 'Sin ruta'}
        </span>
        <span class="font-mono font-bold text-emerald-600 dark:text-emerald-400">${d.vol.toFixed(2)} m³</span>
      </div>
      <div class="text-slate-700 dark:text-slate-200">📍 <b>${esc(d.direccion)}</b> (${esc(d.ciudad)})</div>
      ${d.barrio ? `<div class="text-slate-500 dark:text-slate-400 text-[11px] mt-0.5">🏘️ Barrio: <b>${esc(d.barrio)}</b></div>` : ''}
      <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
        Carga actual en ruta origen: <b>${currentStops.length}</b> clientes · <b>${vol(currentStops).toFixed(2)}</b> m³
      </div>
    `;
  }

  const listEl = document.getElementById('reassignRoutesList');
  if (listEl && S.routes) {
    listEl.innerHTML = S.routes.map((r: any) => {
      const isCurrent = r.id === currentRouteId;
      const st = active(r);
      const curCount = st.length;
      const curVol = vol(st);
      const nextCount = curCount + 1;
      const nextVol = Math.round((curVol + d.vol) * 100) / 100;
      const fitsCount = nextCount <= MAX_DEST;
      const fitsVol = nextVol <= MAX_VOL;
      const canFit = fitsCount && fitsVol;

      let distText = '';
      if (d.lat && d.lng && st.length) {
        const avgD = avgDistToCluster(d, st);
        distText = `~${avgD.toFixed(1)} km`;
      }

      const dominant = getRouteDominantZone(st);
      const zoneLabel = dominant.replace('BOGOTA_', '').replace('_', ' ');

      return `
        <div class="reassign-route-card p-3 rounded-xl border transition flex items-center justify-between ${isCurrent ? 'bg-slate-100 dark:bg-slate-700/30 border-slate-300 dark:border-slate-600 opacity-60 cursor-not-allowed' : (canFit ? 'bg-white dark:bg-slate-700/60 border-slate-200 dark:border-slate-600 hover:border-indigo-500 hover:shadow-xs cursor-pointer' : 'bg-rose-50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40 opacity-70 cursor-not-allowed')}" data-route-id="${r.id}" ${isCurrent || !canFit ? 'data-disabled="true"' : ''}>
          <div class="flex items-center gap-2.5">
            <span class="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs" style="background:${r.color}"></span>
            <div>
              <div class="font-bold text-xs text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                Ruta ${r.id + 1}
                ${isCurrent ? '<span class="text-[10px] font-normal text-slate-400">(Actual)</span>' : ''}
                <span class="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-300">${zoneLabel}</span>
              </div>
              <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                ${curCount} paradas (${curVol.toFixed(1)} m³) ${!isCurrent ? `→ pasará a <b>${nextCount}/15</b> (${nextVol.toFixed(1)}/18 m³)` : ''}
              </div>
            </div>
          </div>
          <div class="text-right shrink-0">
            ${distText ? `<div class="text-[11px] font-semibold text-slate-600 dark:text-slate-300">${distText}</div>` : ''}
            ${!isCurrent ? (canFit ? '<span class="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">Disponible</span>' : '<span class="text-[10px] font-bold text-rose-500">Cupo lleno</span>') : ''}
          </div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.reassign-route-card').forEach((card: any) => {
      card.onclick = () => {
        if (card.dataset.disabled === 'true') return;
        const rId = +card.dataset.routeId;
        reassignTargetRouteId = rId;

        document.querySelectorAll('.reassign-route-card').forEach(c => {
          c.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-50', 'dark:bg-indigo-950/40');
        });
        card.classList.add('ring-2', 'ring-indigo-500', 'bg-indigo-50', 'dark:bg-indigo-950/40');

        const btnConfirm = document.getElementById('confirmReassignBtn') as HTMLButtonElement | null;
        if (btnConfirm) btnConfirm.disabled = false;
      };
    });
  }

  const btnClose = document.getElementById('closeReassignModalBtn');
  if (btnClose) btnClose.onclick = () => closeReassignModal();

  const btnCancel = document.getElementById('cancelReassignBtn');
  if (btnCancel) btnCancel.onclick = () => closeReassignModal();

  const btnConfirm = document.getElementById('confirmReassignBtn') as HTMLButtonElement | null;
  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.onclick = () => confirmReassignModal();
  }

  modal.onclick = (e: MouseEvent) => {
    if (e.target === modal) closeReassignModal();
  };

  const handleEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeReassignModal();
      window.removeEventListener('keydown', handleEsc);
    }
  };
  window.addEventListener('keydown', handleEsc);

  modal.classList.remove('hidden');
}

export function confirmReassignModal(): void {
  if (reassignDestId !== null && reassignTargetRouteId !== null) {
    const destId = reassignDestId;
    const targetRouteId = reassignTargetRouteId;
    withJamarLoader(() => {
      const ok = move(destId, targetRouteId);
      if (ok) closeReassignModal();
    }, 'REASIGNANDO', 'Transfiriendo parada y recalculando tiempos de ruta...', 650);
  } else {
    toast('Selecciona una ruta de destino para transferir la parada', 'warn');
  }
}

export function closeReassignModal(): void {
  const modal = document.getElementById('reassignModal');
  if (modal) modal.classList.add('hidden');
  reassignDestId = null;
  reassignCurrentRouteId = null;
  reassignTargetRouteId = null;
}

export function move(id: number, to: number): boolean {
  id = +id;
  to = +to;
  const dest = S.routes ? S.routes.find(r => r.id === to) : null;
  if (!dest) return false;

  const fromRoutes = (S.routes || []).filter((r: any) => (r.alts?.a || []).some((s: any) => s.id === id) || (r.alts?.b || []).some((s: any) => s.id === id));
  if (!fromRoutes.length) {
    toast('No se encontró la parada en ninguna ruta', 'error');
    return false;
  }
  const from = fromRoutes[0];
  if (from.id === dest.id) return false;

  const d = S.destinations.find(x => x.id === id) || (from.alts?.a || []).find((x: any) => x.id === id) || (from.alts?.b || []).find((x: any) => x.id === id);
  if (!d) return false;

  const targetStops = (active(dest) || []).filter(s => s.id !== id);

  if (targetStops.length + 1 > MAX_DEST || vol(targetStops) + d.vol > MAX_VOL) {
    toast(`No se puede mover: superaría la capacidad máxima (${MAX_DEST} clientes o ${MAX_VOL} m³)`, 'error');
    return false;
  }

  if (!isZoneCompatible(targetStops, d)) {
    toast(`Aviso de zonificación: ${d.cliente} cruza sector hacia Ruta ${dest.id + 1}`, 'warn');
  }

  S.routes.forEach((r: any) => {
    if (r.id !== dest.id && r.alts) {
      let changed = false;
      if (Array.isArray(r.alts.a) && r.alts.a.some((s: any) => s.id === id)) {
        r.alts.a = r.alts.a.filter((s: any) => s.id !== id);
        changed = true;
      }
      if (Array.isArray(r.alts.b) && r.alts.b.some((s: any) => s.id === id)) {
        r.alts.b = r.alts.b.filter((s: any) => s.id !== id);
        changed = true;
      }
      if (changed) {
        r.alts = alternatives(active(r));
        delete r._osrmCache;
      }
    }
  });

  const newDestStops = [...targetStops, d];
  dest.alts = alternatives(newDestStops);
  dest.option = dest.alts.chosen;
  delete (dest as any)._osrmCache;

  deduplicateFleetStops();

  S.currentRouteIndex = dest.id;
  renderRoutes();

  if (S.viewMode === 'all') {
    drawAllRoutes();
  } else {
    draw(dest);
  }

  syncAllRoutesRealDistance();
  toast(`Parada transferida exitosamente a Ruta ${dest.id + 1}`, 'success');
  return true;
}

export function replanRoutes(
  title = 'OPTIMIZANDO',
  subtitle = 'Replaneando rutas y recalculando cubicaje vial OSRM...'
): Promise<void> | void {
  if (!S.destinations || !S.destinations.length) {
    toast('No hay destinos cargados para replanear', 'warn');
    return;
  }

  const valid = S.destinations.filter(d => d.lat && d.lng && d.vol <= MAX_VOL);
  if (!valid.length) {
    toast('No hay destinos geocodificados válidos para replanear', 'warn');
    return;
  }

  return withJamarLoader(() => {
    valid.forEach(d => {
      d.zone = classifyZone(d);
    });

    if (S.routes) {
      S.routes.forEach((r: any) => { delete r._osrmCache; });
    }

    const groups = clusterStrictZones(valid);
    S.routes = groups.map((stops, i) => {
      const x = alternatives(stops);
      return {
        id: i,
        color: S.colors[i % S.colors.length],
        alts: x,
        option: x.chosen,
        visible: true
      };
    });

    deduplicateFleetStops();

    renderRoutes();
    if (S.viewMode === 'all') {
      drawAllRoutes();
    } else if (S.routes[0]) {
      S.currentRouteIndex = 0;
      draw(S.routes[0]);
    }

    syncAllRoutesRealDistance();
    toast(`✅ ${S.routes.length} rutas replanificadas con éxito con direcciones actualizadas y sin duplicados`, 'success');
  }, title, subtitle, 1400);
}

if (typeof window !== 'undefined') {
  (window as any).renderRoutes = renderRoutes;
  (window as any).replanRoutes = replanRoutes;
  (window as any).move = move;
  (window as any).openReassignModal = openReassignModal;
  (window as any).closeReassignModal = closeReassignModal;
  (window as any).confirmReassignModal = confirmReassignModal;
}
