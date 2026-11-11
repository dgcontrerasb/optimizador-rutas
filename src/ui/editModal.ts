import { PhysicalDestination } from '../types';
import { esc, S, safeSet, toast, toastWithAction } from '../state/store';
import { cacheKey, geocodeWithGoogle, loadGoogleMapsScript, normalizeAddress, registerGoogleRequest, sleep } from '../services/geocoding';
import { classifyZone } from '../config/zones';
import { active, alternatives, deduplicateFleetStops } from '../services/routing';
import { renderRoutes, replanRoutes } from './routeCards';
import { draw, drawAllRoutes } from '../map/leafletMap';
import { syncAllRoutesRealDistance } from '../services/osrm';

export let activeEditDestId: number | null = null;
export let selectedCandidateBarrio: string | null = null;
export let selectedCandidateMuni: string | null = null;

export async function searchAddressCandidates(queryText: string, city = 'BOGOTA'): Promise<any[]> {
  const c = (city || 'BOGOTA').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  const isBogota = c === 'BOGOTA' || c.includes('BOGOTA') || !c;
  const cityClean = isBogota ? 'Bogotá' : c;
  const candidates: any[] = [];

  try {
    const gmapsGeocoder = await loadGoogleMapsScript();
    if (gmapsGeocoder && (window as any).google && (window as any).google.maps) {
      let cleanQuery = String(queryText || '').trim();
      try {
        const normCandidate = normalizeAddress(cleanQuery);
        if (normCandidate && normCandidate.found && normCandidate.clean) {
          cleanQuery = normCandidate.clean;
        }
      } catch (e) {}

      const query = isBogota
        ? `${cleanQuery}, Bogotá, Colombia`
        : `${cleanQuery}, ${c}, Cundinamarca, Colombia`;
      const compRestrictions = isBogota
        ? { country: 'CO', administrativeArea: 'Bogota' }
        : { country: 'CO' };

      const gResults: any[] = await new Promise((resolve) => {
        gmapsGeocoder.geocode({
          address: query,
          bounds: new (window as any).google.maps.LatLngBounds(
            new (window as any).google.maps.LatLng(4.4500, -74.4500),
            new (window as any).google.maps.LatLng(4.9000, -73.9500)
          ),
          componentRestrictions: compRestrictions
        }, (results: any[], status: string) => {
          if (status === 'OK' && results && results.length > 0) {
            registerGoogleRequest();
            resolve(results);
          } else {
            resolve([]);
          }
        });
      });

      if (gResults && gResults.length > 0) {
        for (let i = 0; i < Math.min(gResults.length, 4); i++) {
          const top = gResults[i];
          const lat = top.geometry.location.lat();
          const lng = top.geometry.location.lng();
          if (isBogota && lat > 4.90) continue;

          let barrio = '';
          let municipio = '';
          if (Array.isArray(top.address_components)) {
            const bComp = top.address_components.find((comp: any) =>
              comp.types.includes('neighborhood') ||
              comp.types.includes('sublocality') ||
              comp.types.includes('sublocality_level_1') ||
              comp.types.includes('sublocality_level_2')
            );
            if (bComp) barrio = bComp.long_name;

            const mComp = top.address_components.find((comp: any) =>
              comp.types.includes('locality') ||
              comp.types.includes('administrative_area_level_2')
            );
            if (mComp) municipio = mComp.long_name;
            if (!municipio) {
              const sComp = top.address_components.find((comp: any) => comp.types.includes('sublocality_level_1'));
              if (sComp) municipio = sComp.long_name;
            }
          }

          candidates.push({
            lat,
            lng,
            display: top.formatted_address || `${queryText}, ${cityClean}`,
            barrio,
            municipio: municipio || cityClean,
            type: 'google_exact'
          });
        }
      }
    }
  } catch (e) {
    console.warn('Error en búsqueda de candidatos con Google Maps:', e);
  }

  if (candidates.length > 0) {
    return candidates;
  }

  const NOM = 'https://nominatim.openstreetmap.org/search';
  const qStr = queryText.includes(cityClean) ? queryText : `${queryText}, ${cityClean}, Colombia`;

  const fetchNominatim = async (q: string) => {
    const u = NOM + '?format=json&limit=5&addressdetails=1&viewbox=-74.40,4.90,-73.90,4.50&bounded=1&' + new URLSearchParams({ q });
    try {
      const r = await fetch(u, { headers: { 'Accept-Language': 'es' } });
      if (!r.ok) return [];
      const items = await r.json();
      return (items || [])
        .filter((it: any) => !(isBogota && +it.lat > 4.90))
        .map((it: any) => {
          const addr = it.address || {};
          const itBarrio = addr.suburb || addr.neighbourhood || addr.residential || addr.city_district || '';
          const itMuni = addr.city || addr.town || addr.municipality || addr.county || cityClean;
          return {
            lat: +it.lat,
            lng: +it.lon,
            display: it.display_name,
            barrio: itBarrio,
            municipio: itMuni,
            type: it.type || 'osm'
          };
        });
    } catch (e) {
      return [];
    }
  };

  let results = await fetchNominatim(qStr);
  if (!results.length) {
    const mInter = queryText.match(/^([A-Za-z]+(?:\s+[A-Za-z]+)?\s+\d+[A-Za-z]?(?:\s+SUR|\s+ESTE|\s+NORTE|\s+OESTE|\s+BIS)?)\s*#\s*(\d+[A-Za-z]?(?:\s+SUR|\s+ESTE|\s+NORTE|\s+OESTE|\s+BIS)?)/i);
    if (mInter) {
      const p1 = mInter[1].trim();
      let p2 = mInter[2].trim();
      let qAlt: string | null = null;
      if (/^Calle\b/i.test(p1) && !/^(Carrera|CR|CRA)\b/i.test(p2)) {
        qAlt = `Carrera ${p2} con ${p1}, ${cityClean}, Colombia`;
      } else if (/^Carrera\b/i.test(p1) && !/^(Calle|CL|CLL)\b/i.test(p2)) {
        qAlt = `${p1} con Calle ${p2}, ${cityClean}, Colombia`;
      }
      if (qAlt) {
        results = await fetchNominatim(qAlt);
      }
    }
  }
  if (!results.length) {
    const gridFallback = await geocodeWithGoogle(queryText, city);
    if (gridFallback && Number.isFinite(gridFallback.lat) && Number.isFinite(gridFallback.lng)) {
      results.push({
        lat: gridFallback.lat,
        lng: gridFallback.lng,
        display: gridFallback.display,
        barrio: gridFallback.barrio || '',
        municipio: gridFallback.municipio || cityClean,
        type: 'grid_colombia'
      });
    }
  }
  return results;
}

export function openEditLocationModal(destId: number): void {
  const d = S.destinations.find(x => x.id === destId) || (S.alerts && S.alerts.find(x => x.id === destId));
  if (!d) return;
  activeEditDestId = destId;
  selectedCandidateBarrio = null;
  selectedCandidateMuni = null;

  const clientNameEl = document.getElementById('modalClientName');
  if (clientNameEl) clientNameEl.textContent = `${d.cliente} (ID: ${d.id}) · ${d.ciudad}`;

  const addrInput = document.getElementById('modalInputAddr') as HTMLInputElement | null;
  if (addrInput) addrInput.value = d.direccion;

  const latInput = document.getElementById('modalInputLat') as HTMLInputElement | null;
  if (latInput) latInput.value = d.lat ? d.lat.toFixed(6) : '';

  const lngInput = document.getElementById('modalInputLng') as HTMLInputElement | null;
  if (lngInput) lngInput.value = d.lng ? d.lng.toFixed(6) : '';

  const gmapsQuery = encodeURIComponent(`${d.direccion}, ${d.ciudad}, Colombia`);
  const gmapsLink = document.getElementById('modalGmapsVerifyLink') as HTMLAnchorElement | null;
  if (gmapsLink) gmapsLink.href = `https://www.google.com/maps/search/?api=1&query=${gmapsQuery}`;

  const candidatesList = document.getElementById('modalCandidatesList');
  if (candidatesList) candidatesList.innerHTML = '<p class="text-slate-400 text-center py-3">Buscando alternativas...</p>';

  const modal = document.getElementById('editLocModal');
  if (modal) modal.classList.remove('hidden');

  triggerModalSearch(d.direccion, d.ciudad);
}

export async function triggerModalSearch(addr: string, city: string): Promise<void> {
  const candidatesList = document.getElementById('modalCandidatesList');
  if (!candidatesList) return;
  candidatesList.innerHTML = '<p class="text-slate-500 text-center py-3">🔍 Consultando opciones de ubicación...</p>';

  const candidates = await searchAddressCandidates(addr, city);
  if (!candidates || !candidates.length) {
    candidatesList.innerHTML = `
      <div class="p-3 text-center text-slate-500 space-y-1">
        <p>No se encontraron coincidencias automáticas.</p>
        <p class="text-[11px] text-slate-400">Puedes modificar la dirección arriba o abrir Google Maps y pegar las coordenadas (Lat, Lng).</p>
      </div>
    `;
    return;
  }

  candidatesList.innerHTML = candidates.map((cand, i) => {
    const muniUpper = (cand.municipio || '').toUpperCase();
    const isUrbanBogota = muniUpper.includes('BOGOTA') ||
      ['USAQUEN', 'CHAPINERO', 'SANTA FE', 'SAN CRISTOBAL', 'USME', 'TUNJUELITO', 'BOSA', 'KENNEDY', 'FONTIBON', 'ENGATIVA', 'SUBA', 'BARRIOS UNIDOS', 'TEUSAQUILLO', 'LOS MARTIRES', 'ANTONIO NARINO', 'PUENTE ARANDA', 'LA CANDELARIA', 'RAFAEL URIBE', 'CIUDAD BOLIVAR'].some(loc => muniUpper.includes(loc)) ||
      (cand.lat >= 4.50 && cand.lat <= 4.82 && cand.lng >= -74.22 && cand.lng <= -74.00);

    return `
      <div class="candidate-item p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-xs cursor-pointer transition flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
           data-lat="${cand.lat}"
           data-lng="${cand.lng}"
           data-disp="${esc(cand.display)}"
           data-barrio="${esc(cand.barrio || '')}"
           data-muni="${esc(cand.municipio || '')}">
        <div class="space-y-1.5 flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${cand.type === 'google_exact' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}">
              Opción ${i + 1}
            </span>
            ${cand.type === 'google_exact' ? '<span class="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold inline-flex items-center gap-1">🟢 Google Maps</span>' : '<span class="text-[10px] text-slate-500 font-medium">📍 OSM</span>'}
            <span class="text-xs font-semibold text-slate-900 dark:text-white truncate max-w-[340px]" title="${esc(cand.display)}">
              ${esc(cand.display)}
            </span>
          </div>

          <div class="flex items-center gap-1.5 flex-wrap">
            ${cand.barrio ? `
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-bold bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800/80 shadow-2xs">
                🏘️ Barrio: <span class="underline decoration-amber-400 font-extrabold">${esc(cand.barrio)}</span>
              </span>
            ` : `
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[10px] text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700">
                🏘️ Barrio no especificado
              </span>
            `}

            ${cand.municipio ? `
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-[11px] font-bold ${isUrbanBogota ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-800 dark:text-blue-300 border border-blue-200 dark:border-blue-800/80' : 'bg-purple-50 dark:bg-purple-950/60 text-purple-800 dark:text-purple-300 border border-purple-200 dark:border-purple-800/80'} shadow-2xs">
                🏙️ Municipio/Localidad: <span class="font-extrabold">${esc(cand.municipio)}</span>
              </span>
            ` : ''}

            ${isUrbanBogota ? `
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60">
                ✓ Bogotá Urbana
              </span>
            ` : (cand.municipio && cand.municipio.toUpperCase() !== 'BOGOTA' ? `
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 border border-purple-200 dark:border-purple-800/60">
                🚗 Sabana / Municipio
              </span>
            ` : '')}
          </div>

          <div class="text-[11px] text-slate-400 dark:text-slate-500 font-mono">
            📍 Lat: ${cand.lat.toFixed(6)}, Lng: ${cand.lng.toFixed(6)}
          </div>
        </div>

        <button type="button" class="select-cand-btn px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-xs shrink-0 shadow-xs transition inline-flex items-center gap-1 cursor-pointer">
          <span>Elegir esta</span>
          <span>✓</span>
        </button>
      </div>
    `;
  }).join('');

  candidatesList.querySelectorAll('.candidate-item').forEach((el: any) => {
    el.onclick = () => {
      const latIn = document.getElementById('modalInputLat') as HTMLInputElement | null;
      const lngIn = document.getElementById('modalInputLng') as HTMLInputElement | null;
      if (latIn) latIn.value = (+el.dataset.lat).toFixed(6);
      if (lngIn) lngIn.value = (+el.dataset.lng).toFixed(6);
      if (el.dataset.barrio) selectedCandidateBarrio = el.dataset.barrio;
      if (el.dataset.muni) selectedCandidateMuni = el.dataset.muni;

      candidatesList.querySelectorAll('.candidate-item').forEach(c => {
        c.classList.remove('ring-2', 'ring-blue-500', 'bg-blue-50/60', 'dark:bg-blue-950/40');
      });
      el.classList.add('ring-2', 'ring-blue-500', 'bg-blue-50/60', 'dark:bg-blue-950/40');
      const bText = el.dataset.barrio ? ` (${el.dataset.barrio})` : '';
      const mText = el.dataset.muni ? ` en ${el.dataset.muni}` : '';
      toast(`Ubicación seleccionada${bText}${mText}. Haz clic en "Guardar y Aplicar"`, 'info');
    };
  });
}

export function closeEditLocationModal(): void {
  const modal = document.getElementById('editLocModal');
  if (modal) modal.classList.add('hidden');
  activeEditDestId = null;
  selectedCandidateBarrio = null;
  selectedCandidateMuni = null;
}

export function renderAlerts(): void {
  const alertsEl = document.getElementById('alerts');
  if (!alertsEl) return;

  alertsEl.innerHTML = S.alerts.map((d: any) => {
    const gmapsSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.direccion}, ${d.ciudad}, Colombia`)}`;
    return `
      <div class="p-3.5 rounded-xl border border-amber-300 dark:border-amber-600 bg-amber-50/70 dark:bg-slate-800 text-xs">
        <div class="flex justify-between items-center mb-1.5 flex-wrap gap-1">
          <div class="flex items-center gap-2">
            <strong class="text-sm">${esc(d.cliente)}</strong>
            <span class="px-2 py-0.5 rounded badge-alert text-[11px] font-semibold">${d.confidence}</span>
            <span class="px-2 py-0.5 rounded badge-muted text-[11px]">${d.pedidos ? d.pedidos.length : 1} pedido(s) · ${d.vol.toFixed(2)} m³</span>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="edit-loc-btn px-2.5 py-1 bg-brand-500 hover:bg-brand-600 text-white rounded-lg text-xs font-semibold shadow-xs flex items-center gap-1 transition cursor-pointer" data-id="${d.id}">
              ✏️ Corregir / Ver Opciones
            </button>
            <a href="${gmapsSearchUrl}" target="_blank" rel="noopener noreferrer" class="px-2.5 py-1 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 rounded-lg text-xs font-medium flex items-center gap-1">
              📍 Google Maps
            </a>
          </div>
        </div>
        <p class="text-slate-600 dark:text-slate-400">
          Original: <b>${esc(d.direccionOriginal)}</b> · Ciudad: ${esc(d.ciudad)}
        </p>
        <div class="flex gap-2 mt-2 flex-wrap items-center">
          <input class="alertAddr flex-1 min-w-[200px] p-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white" data-id="${d.id}" value="${esc(d.direccion)}">
          <input class="alertLat w-24 p-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white" data-id="${d.id}" placeholder="Lat" value="${d.lat ? d.lat.toFixed(5) : ''}">
          <input class="alertLng w-24 p-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white" data-id="${d.id}" placeholder="Lng" value="${d.lng ? d.lng.toFixed(5) : ''}">
        </div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.edit-loc-btn').forEach((btn: any) => {
    btn.onclick = () => openEditLocationModal(+btn.dataset.id);
  });
}

export function initEditModalListeners(): void {
  const closeBtn = document.getElementById('closeModalBtn');
  if (closeBtn) closeBtn.onclick = closeEditLocationModal;

  const cancelBtn = document.getElementById('modalCancelBtn');
  if (cancelBtn) cancelBtn.onclick = closeEditLocationModal;

  const searchBtn = document.getElementById('modalSearchBtn');
  if (searchBtn) {
    searchBtn.onclick = () => {
      const addrIn = document.getElementById('modalInputAddr') as HTMLInputElement | null;
      const addr = addrIn ? addrIn.value.trim() : '';
      if (!addr) {
        toast('Escribe una dirección para buscar', 'warn');
        return;
      }
      const d = S.destinations.find(x => x.id === activeEditDestId) || (S.alerts && S.alerts.find(x => x.id === activeEditDestId));
      const city = d ? d.ciudad : 'BOGOTA';
      const gmapsQuery = encodeURIComponent(`${addr}, ${city}, Colombia`);
      const gmapsLink = document.getElementById('modalGmapsVerifyLink') as HTMLAnchorElement | null;
      if (gmapsLink) gmapsLink.href = `https://www.google.com/maps/search/?api=1&query=${gmapsQuery}`;
      triggerModalSearch(addr, city);
    };
  }

  const saveBtn = document.getElementById('modalSaveBtn') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (activeEditDestId === null) return;
      const d = S.destinations.find(x => x.id === activeEditDestId) || (S.alerts && S.alerts.find(x => x.id === activeEditDestId));
      if (!d) return;

      const originalText = saveBtn.innerHTML;
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<span>⏳ Guardando...</span>';

      try {
        const addrIn = document.getElementById('modalInputAddr') as HTMLInputElement | null;
        const latIn = document.getElementById('modalInputLat') as HTMLInputElement | null;
        const lngIn = document.getElementById('modalInputLng') as HTMLInputElement | null;

        const newAddr = addrIn ? addrIn.value.trim() : '';
        const inputLat = latIn ? parseFloat(latIn.value) : NaN;
        const inputLng = lngIn ? parseFloat(lngIn.value) : NaN;

        try {
          const oldKey = cacheKey(d);
          localStorage.removeItem(oldKey);
          if (newAddr) {
            localStorage.removeItem(cacheKey({ direccion: newAddr, ciudad: d.ciudad }));
          }
        } catch (e) {}

        const manualCoordsEntered = Number.isFinite(inputLat) && Number.isFinite(inputLng) &&
          (d.lat === null || d.lat === undefined || Math.abs(inputLat - d.lat) > 0.00001 || Math.abs(inputLng - d.lng) > 0.00001);

        if (newAddr && (!manualCoordsEntered || !d.lat)) {
          const gRes = await geocodeWithGoogle(newAddr, d.ciudad);
          if (gRes && Number.isFinite(gRes.lat) && Number.isFinite(gRes.lng)) {
            d.lat = gRes.lat;
            d.lng = gRes.lng;
            d.confidence = gRes.confidence || 'Encontrada exacta (Google Maps)';
            d.strategy = gRes.strategy || 'Google Maps Geocoder';
            (d as any).display = gRes.display || `${newAddr}, ${d.ciudad}`;
            if (gRes.barrio && !selectedCandidateBarrio) d.barrio = gRes.barrio;
            if (gRes.municipio && !selectedCandidateMuni) d.ciudad = gRes.municipio;
          } else if (Number.isFinite(inputLat) && Number.isFinite(inputLng)) {
            d.lat = inputLat;
            d.lng = inputLng;
            d.confidence = 'Corregida manualmente';
            d.strategy = 'Selección manual del usuario';
          }
        } else if (Number.isFinite(inputLat) && Number.isFinite(inputLng)) {
          d.lat = inputLat;
          d.lng = inputLng;
          d.confidence = 'Corregida manualmente';
          d.strategy = 'Selección manual del usuario';
        }

        if (selectedCandidateBarrio) d.barrio = selectedCandidateBarrio;
        if (selectedCandidateMuni) d.ciudad = selectedCandidateMuni;
        if (newAddr) d.direccion = newAddr;
        d.zone = classifyZone(d);

        const k = cacheKey(d);
        safeSet(k, JSON.stringify({
          lat: d.lat,
          lng: d.lng,
          display: (d as any).display || `${d.direccion}, ${d.ciudad}`,
          confidence: d.confidence,
          strategy: d.strategy
        }));

        closeEditLocationModal();

        if (S.alerts && S.alerts.length) {
          S.alerts = S.alerts.filter(x => x.id !== d.id || !x.lat);
          const statAlDiv = document.querySelector('#statAl div');
          if (statAlDiv) statAlDiv.textContent = String(S.alerts.length);
          renderAlerts();
          if (S.alerts.length === 0) {
            const alertsSec = document.getElementById('alertsSec');
            if (alertsSec) alertsSec.classList.add('hidden');
            if ((window as any).generate) (window as any).generate();
            return;
          }
        }

        if (S.routes && S.routes.length) {
          let affectedRoute: any = null;
          S.routes.forEach((r: any) => {
            let isAffected = false;
            if (r.alts) {
              ['a', 'b'].forEach((altKey: string) => {
                if (Array.isArray(r.alts[altKey])) {
                  r.alts[altKey].forEach((st: any) => {
                    if (st.id === d.id) {
                      st.lat = d.lat;
                      st.lng = d.lng;
                      st.direccion = d.direccion;
                      st.zone = d.zone;
                      if (d.barrio) st.barrio = d.barrio;
                      if (d.ciudad) st.ciudad = d.ciudad;
                      isAffected = true;
                    }
                  });
                }
              });
            }
            const stops = active(r);
            const foundIdx = stops.findIndex(x => x.id === d.id);
            if (foundIdx !== -1) {
              stops[foundIdx].lat = d.lat;
              stops[foundIdx].lng = d.lng;
              stops[foundIdx].direccion = d.direccion;
              stops[foundIdx].zone = d.zone;
              if (d.barrio) stops[foundIdx].barrio = d.barrio;
              if (d.ciudad) stops[foundIdx].ciudad = d.ciudad;
              isAffected = true;
            }
            if (isAffected) {
              delete r._osrmCache;
              affectedRoute = r;
              r.alts = alternatives(stops);
            }
          });

          deduplicateFleetStops();
          renderRoutes();

          if (affectedRoute) {
            delete affectedRoute._osrmCache;
          }

          if (S.viewMode === 'all') {
            drawAllRoutes();
          } else if (affectedRoute) {
            draw(affectedRoute);
          } else if (S.routes[S.currentRouteIndex]) {
            draw(S.routes[S.currentRouteIndex]);
          }

          syncAllRoutesRealDistance();

          toastWithAction(
            `Ubicación actualizada para ${d.cliente}. ¿Deseas replanear las rutas para optimizar su asignación geográfica?`,
            '🔄 Replanear Rutas',
            () => replanRoutes(),
            'success'
          );
        } else {
          toast(`Ubicación actualizada para ${d.cliente}`, 'success');
        }
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = originalText;
      }
    };
  }
}

if (typeof window !== 'undefined') {
  (window as any).openEditLocationModal = openEditLocationModal;
  (window as any).closeEditLocationModal = closeEditLocationModal;
}
