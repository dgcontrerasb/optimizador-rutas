import { MAX_DEST, MAX_VOL } from '../config/constants';
import { S, safeSet, toast } from '../state/store';
import { active, vol } from '../services/routing';
import { getRouteEffectiveKm } from '../services/osrm';
import { getRouteDominantZone } from './routeCards';
import { currentMapLayer, updateLayerButtonsUI } from '../map/leafletMap';

declare const XLSX: any;

export function toggleMapFullscreen(): void {
  const mapWrap = document.getElementById('mapWrap');
  if (!mapWrap) return;

  const isFs = Boolean(document.fullscreenElement) || mapWrap.classList.contains('fullscreen-map-active');
  const icon = document.getElementById('fullscreenIcon');
  const text = document.getElementById('fullscreenText');
  const btn = document.getElementById('btnToggleFullscreen');

  if (isFs) {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    mapWrap.classList.remove('fullscreen-map-active');
    if (icon) icon.textContent = '⛶';
    if (text) text.textContent = 'Completa';
    if (btn) btn.title = 'Ver mapa en pantalla completa (o presiona F / Esc)';
    toast('Saliste de la vista de pantalla completa', 'info');
  } else {
    if (mapWrap.requestFullscreen) {
      mapWrap.requestFullscreen().catch(() => {
        mapWrap.classList.add('fullscreen-map-active');
      });
    } else {
      mapWrap.classList.add('fullscreen-map-active');
    }
    if (icon) icon.textContent = '🗗';
    if (text) text.textContent = 'Salir';
    if (btn) btn.title = 'Salir de pantalla completa (Esc)';
    toast('Modo pantalla completa activado. Presiona Esc para salir.', 'info');
  }

  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 120);
  setTimeout(() => {
    if (S.map) S.map.invalidateSize();
  }, 350);
}

export function saveFile(name: string, content: any, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

function sanitizeCell(val: any): any {
  if (typeof val === 'string' && val.length > 0) {
    const first = val.charAt(0);
    if (first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r') {
      return `'${val}`;
    }
  }
  return val;
}

function sanitizeRow<T extends Record<string, any>>(row: T): T {
  const clean: any = {};
  for (const k in row) {
    clean[k] = sanitizeCell(row[k]);
  }
  return clean;
}

export function exportFull(): {
  cons: any[];
  ordersList: any[];
  routesList: any[];
  excluded: any[];
  raw: any[];
} {
  const cons = S.destinations.map((d: any) => ({
    tipo: 'Destino',
    estado: d.lat ? 'RUTEABLE LOCALMENTE' : 'ALERTA',
    pedido: d.pedidos ? d.pedidos.join(' | ') : '',
    cliente: d.cliente,
    cedula: d.cedula || '',
    direccion_original: d.direccionOriginal,
    direccion_normalizada: d.direccion,
    complemento: d.complemento || '',
    barrio: d.barrio || '',
    ciudad: d.ciudad,
    volumen_m3: d.vol,
    num_pedidos: d.numOrders || 1,
    lat: d.lat || '',
    lng: d.lng || '',
    confianza: d.confidence || '',
    estrategia: d.strategy || ''
  }));

  const ordersList = S.orders.map(o => ({
    pedido: o.pedido,
    cliente: o.cliente,
    cedula: (o as any).cedula || '',
    direccion_original: o.direccionOriginal,
    direccion_normalizada: o.direccion,
    barrio: o.barrio,
    ciudad: o.ciudad,
    volumen_m3: o.vol,
    articulos: (o as any).items || 1
  }));

  const routesList: any[] = [];
  S.routes.forEach(r => {
    const st = active(r);
    const km = getRouteEffectiveKm(r);
    const zoneName = getRouteDominantZone(st);

    st.forEach((d: any, idx: number) => {
      routesList.push({
        ruta: `Ruta ${r.id + 1}`,
        macro_zona: zoneName,
        opcion_activa: r.option,
        distancia_km: km,
        orden_parada: idx + 1,
        pedido: d.pedidos ? d.pedidos.join(' | ') : '',
        cliente: d.cliente,
        direccion: d.direccion,
        ciudad: d.ciudad,
        volumen_m3: d.vol,
        lat: d.lat || '',
        lng: d.lng || ''
      });
    });
  });

  const excluded = (S.stats.excludedRows || []).map((r: any) => ({
    tipo: 'Excluido',
    motivo_exclusion: r._motivo || 'No ruteable',
    pedido: r.Pedido || r.orden || '',
    cliente: r['Nombre destinatario de mercancías'] || r.Cliente || '',
    cedula: r.Cédula || r.Documento || '',
    ciudad: r['Lugar-destinatario'] || r.Ciudad || '',
    direccion: r.Dirección || r.Direccion || '',
    volumen: r.Volumen || '',
    descripcion: r.Descripción || r.Descripcion || ''
  }));

  return {
    cons: cons.map(sanitizeRow),
    ordersList: ordersList.map(sanitizeRow),
    routesList: routesList.map(sanitizeRow),
    excluded: excluded.map(sanitizeRow),
    raw: (S.rawRows || []).map(r => (typeof r === 'object' && r ? sanitizeRow(r) : r))
  };
}

export function updateDistModeUI(): void {
  const mode = S.routeDistributionMode || 'comfort';
  const isComfort = mode === 'comfort';

  const btnComfort = document.getElementById('btnDistComfort');
  const btnMax = document.getElementById('btnDistMax');
  const badge = document.getElementById('distModeBadge');
  const expl = document.getElementById('distModeExplanation');
  const headerText = document.getElementById('headerRouteTargetText');
  const statVolTarget = document.getElementById('statVolTarget');
  const statDestTarget = document.getElementById('statDestTarget');

  if (btnComfort && btnMax) {
    if (isComfort) {
      btnComfort.className = 'px-3 py-1 rounded-full text-xs font-bold transition shadow-xs bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 cursor-pointer';
      btnMax.className = 'px-3 py-1 rounded-full text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition cursor-pointer';
    } else {
      btnMax.className = 'px-3 py-1 rounded-full text-xs font-bold transition shadow-xs bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 cursor-pointer';
      btnComfort.className = 'px-3 py-1 rounded-full text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition cursor-pointer';
    }
  }

  if (badge) {
    badge.textContent = isComfort ? 'Ruta Cómoda Activa' : 'Capacidad Máxima';
    badge.className = isComfort
      ? 'px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : 'px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300';
  }

  if (expl) {
    expl.textContent = isComfort
      ? 'Distribuye de forma balanceada (8–11 clientes y 11–14 m³). Los 15 clientes y 18 m³ son límites máximos de seguridad.'
      : 'Llena cada camión lo más cerca posible de los límites máximos permitidos (hasta 15 clientes y 18 m³).';
  }

  if (headerText) {
    headerText.textContent = isComfort
      ? '🌱 Modo Cómodo: 8–11 clientes y 11–14 m³ (Tope de seguridad 15 clientes / 18 m³)'
      : '📦 Modo Máximo: Hasta 15 clientes y 18 m³ por camión';
  }

  if (statVolTarget && statDestTarget) {
    statVolTarget.innerHTML = isComfort ? '11–14 <span class="text-xs font-normal text-slate-400">m³</span>' : '18 <span class="text-xs font-normal text-slate-400">m³ máx</span>';
    statDestTarget.innerHTML = isComfort ? '8–11 <span class="text-xs font-normal text-slate-400">clientes</span>' : '15 <span class="text-xs font-normal text-slate-400">clientes máx</span>';
  }

  const rightPanelVolTarget = document.getElementById('rightPanelVolTarget');
  if (rightPanelVolTarget) {
    rightPanelVolTarget.textContent = isComfort ? '11.0–14.0 m³' : '18.0 m³ máx';
  }
}

export function setRouteDistributionMode(mode: 'comfort' | 'max_capacity'): void {
  S.routeDistributionMode = mode;
  safeSet('rutasjamar_dist_mode', mode);
  updateDistModeUI();
  if (S.destinations && S.destinations.some(d => d.lat && d.lng)) {
    const title = 'CUBICAJE';
    const subtitle = mode === 'comfort'
      ? 'Aplicando flota Cómoda (11–14 m³, balanceada)...'
      : 'Aplicando Capacidad Máxima (18 m³ máx por camión)...';

    if ((window as any).replanRoutes) {
      (window as any).replanRoutes(title, subtitle);
    } else if ((window as any).generate) {
      (window as any).generate();
    }
  }
}

export function initToolbarListeners(): void {
  const darkBtn = document.getElementById('darkBtn');
  if (darkBtn) {
    darkBtn.onclick = () => {
      const isDark = document.documentElement.classList.toggle('dark');
      darkBtn.textContent = isDark ? '☀️' : '🌙';
      updateLayerButtonsUI(currentMapLayer);
    };
  }

  const downloadHtmlBtn = document.getElementById('downloadHtmlBtn');
  if (downloadHtmlBtn) {
    downloadHtmlBtn.onclick = async () => {
      try {
        const res = await fetch(window.location.href);
        let htmlText = '';
        if (res.ok) {
          htmlText = await res.text();
        }
        if (!htmlText || !htmlText.includes('<!DOCTYPE html>')) {
          htmlText = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        }
        saveFile('RutasJamar_App.html', htmlText, 'text/html;charset=utf-8');
        toast('¡Archivo HTML descargado con éxito!', 'success');
      } catch (e) {
        const fallbackHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
        saveFile('RutasJamar_App.html', fallbackHtml, 'text/html;charset=utf-8');
        toast('¡Archivo HTML descargado con éxito!', 'success');
      }
    };
  }

  const exportBtn = document.getElementById('exportBtn');
  const exportMenu = document.getElementById('exportMenu');

  if (exportBtn && exportMenu) {
    exportBtn.onclick = (e) => {
      e.stopPropagation();
      exportMenu.classList.toggle('hidden');
    };

    exportMenu.querySelectorAll('button, a').forEach(item => {
      item.addEventListener('click', () => {
        exportMenu.classList.add('hidden');
      });
    });

    document.addEventListener('click', (e) => {
      if (!exportMenu.contains(e.target as Node) && !exportBtn.contains(e.target as Node)) {
        exportMenu.classList.add('hidden');
      }
    });
  }

  const btnDistComfort = document.getElementById('btnDistComfort');
  const btnDistMax = document.getElementById('btnDistMax');
  if (btnDistComfort) btnDistComfort.onclick = () => setRouteDistributionMode('comfort');
  if (btnDistMax) btnDistMax.onclick = () => setRouteDistributionMode('max_capacity');

  const btnToggleFullscreen = document.getElementById('btnToggleFullscreen');
  if (btnToggleFullscreen) btnToggleFullscreen.onclick = toggleMapFullscreen;

  document.addEventListener('fullscreenchange', () => {
    const mapWrap = document.getElementById('mapWrap');
    const icon = document.getElementById('fullscreenIcon');
    const text = document.getElementById('fullscreenText');
    if (!document.fullscreenElement && mapWrap) {
      mapWrap.classList.remove('fullscreen-map-active');
      if (icon) icon.textContent = '⛶';
      if (text) text.textContent = 'Pantalla Completa';
    }
    setTimeout(() => {
      if (S.map) S.map.invalidateSize();
    }, 200);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const mapWrap = document.getElementById('mapWrap');
      if (mapWrap && mapWrap.classList.contains('fullscreen-map-active')) {
        toggleMapFullscreen();
      }
    } else if ((e.key === 'f' || e.key === 'F') && !(e.target as HTMLElement).closest('input, textarea, select')) {
      toggleMapFullscreen();
    }
  });

  // Exportaciones de rutas
  const csvRoutesBtn = document.getElementById('csvRoutes');
  if (csvRoutesBtn) {
    csvRoutesBtn.onclick = () => {
      const { routesList } = exportFull();
      const ws = XLSX.utils.json_to_sheet(routesList);
      const csv = XLSX.utils.sheet_to_csv(ws);
      saveFile('rutas_asignadas.csv', csv, 'text/csv;charset=utf-8');
    };
  }

  const pdfBtn = document.getElementById('pdf');
  if (pdfBtn) {
    pdfBtn.onclick = () => {
      const { jsPDF } = (window as any).jspdf || {};
      if (!jsPDF) {
        toast('Librería jsPDF no disponible', 'error');
        return;
      }
      const doc = new jsPDF();
      S.routes.forEach((r, k) => {
        if (k > 0) doc.addPage();
        const st = active(r);
        const km = getRouteEffectiveKm(r);
        const zoneName = getRouteDominantZone(st);

        doc.setFontSize(15);
        doc.text(`Ruta ${r.id + 1} (${zoneName.replace(/_/g, ' ')}) - Opción ${r.option}`, 14, 18);
        doc.setFontSize(9);
        doc.text(
          `Paradas: ${st.length}/${MAX_DEST} | Volumen: ${vol(st).toFixed(2)}/${MAX_VOL} m3 | Distancia vial real: ${km} km`,
          14,
          25
        );

        st.forEach((d: any, i: number) => {
          const y = 35 + i * 8;
          if (y < 280) {
            doc.text(`${i + 1}. ${d.cliente} | ${d.direccion} (${d.ciudad}) - ${d.vol.toFixed(2)} m3`, 14, y);
          }
        });
      });
      doc.save('rutas_jamar.pdf');
    };
  }

  const csvFullBtn = document.getElementById('csvFull');
  if (csvFullBtn) {
    csvFullBtn.onclick = () => {
      const x = exportFull();
      const rows = [...x.cons, ...x.excluded];
      const ws = XLSX.utils.json_to_sheet(rows);
      const csv = XLSX.utils.sheet_to_csv(ws);
      saveFile('rutasjamar_consolidado_completo.csv', csv, 'text/csv;charset=utf-8');
    };
  }

  const xlsxFullBtn = document.getElementById('xlsxFull');
  if (xlsxFullBtn) {
    xlsxFullBtn.onclick = () => {
      const x = exportFull();
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.cons), 'Destinos Físicos');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.ordersList), 'Pedidos Consolidados');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.routesList), 'Rutas Asignadas');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.excluded), 'Excluidos');
      if (x.raw && x.raw.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(x.raw), 'Filas Originales');
      }
      XLSX.writeFile(wb, 'rutasjamar_completo.xlsx');
    };
  }
}

if (typeof window !== 'undefined') {
  (window as any).toggleMapFullscreen = toggleMapFullscreen;
  (window as any).exportFull = exportFull;
  (window as any).saveFile = saveFile;
  (window as any).setRouteDistributionMode = setRouteDistributionMode;
  (window as any).updateDistModeUI = updateDistModeUI;
}
