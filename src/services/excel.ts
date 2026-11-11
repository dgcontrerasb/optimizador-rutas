import { CITIES, CORRECTIONS } from '../config/constants';
import { ColumnMapping, OrderItem, PhysicalDestination, PreprocessStats } from '../types';
import { normalizeAddress, getJamarBranchAddress } from './geocoding';
import { classifyZone, normalizeInsensitive, normText } from '../config/zones';
import { esc, toast } from '../state/store';

declare const XLSX: any;

export const CM_DEFAULTS: ColumnMapping = {
  order: 'Pedido',
  name: 'Nombre destinatario de mercancías',
  id: 'Cédula',
  addr: 'Dirección',
  neigh: 'Barrio',
  city: 'Lugar-destinatario',
  phone: 'Teléfono',
  volume: 'Volumen',
  desc: 'Descripción'
};

export const CM_PATTERNS: Record<string, RegExp[]> = {
  order: [/pedido/i, /orden/i, /nro.*pedido/i, /num.*pedido/i, /delivery/i, /remisi[oó]n/i, /gu[ií]a/i, /factura/i, /env[ií]o/i, /\bnro\b/i, /consecutivo/i, /solicitud/i],
  name: [/nombre\s*destinatario/i, /destinatario/i, /cliente/i, /nombre.*cliente/i, /nombre/i, /razon\s*social/i, /receptor/i, /contacto/i, /titular/i],
  id: [/c[eé]dula/i, /identificaci[oó]n/i, /documento/i, /nit/i, /\bcc\b/i, /\bdoc\b/i, /\bced\b/i, /rut/i, /identidad/i],
  addr: [/direcci[oó]n/i, /direccion/i, /domicilio/i, /\bdir\b/i, /nomenclatura/i, /ubicaci[oó]n/i, /punto\s*entrega/i, /destino/i, /lugar/i],
  neigh: [/barrio/i, /sector/i, /urbanizaci[oó]n/i, /localidad/i, /comuna/i, /zona/i, /vecindario/i],
  city: [/lugar.*destinatario/i, /ciudad/i, /municipio/i, /destino/i, /poblaci[oó]n/i, /dpto/i, /departamento/i, /municip/i],
  phone: [/tel[eé]fono/i, /telefono/i, /celular/i, /contacto/i, /movil/i, /m[oó]vil/i, /\btel\b/i, /\bcel\b/i],
  volume: [/volumen/i, /\bvol\b/i, /m3/i, /metros\s*c[uú]bicos/i, /cubicaje/i, /capacidad/i, /peso/i, /kilos/i, /kg/i, /cbm/i],
  desc: [/descripci[oó]n/i, /descripcion/i, /detalle/i, /art[ií]culo/i, /producto/i, /mercanc[ií]a/i, /referencia/i, /obs/i, /observaci[oó]n/i]
};

export function normClean(s: any): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function levenshteinDistance(s1: string, s2: string): number {
  if (s1 === s2) return 0;
  if (!s1) return (s2 || '').length;
  if (!s2) return s1.length;
  const d: number[][] = [];
  for (let i = 0; i <= s1.length; i++) d[i] = [i];
  for (let j = 0; j <= s2.length; j++) d[0][j] = j;
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
    }
  }
  return d[s1.length][s2.length];
}

export function isCendisBogota(...fields: any[]): boolean {
  for (const f of fields) {
    if (!f) continue;
    const clean = normalizeInsensitive(f)
      .replace(/[.,\-_#/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (
      clean === 'CENDIS' ||
      clean.includes('CENDIS BOGOTA') ||
      clean.includes('CENDIS SIBERIA') ||
      clean.includes('CENDIS JAMAR') ||
      clean.includes('CENDIS BOG') ||
      clean.startsWith('CENDIS ') ||
      clean.endsWith(' CENDIS')
    ) {
      return true;
    }
  }
  return false;
}

export function detectAddressColByContent(headers: string[], rows: any[]): string | null {
  if (!Array.isArray(headers) || !Array.isArray(rows) || !rows.length) return null;
  const sample = rows.slice(0, 20);
  const ADDR_PATTERN = /\b(CL|CALLE|CRA|CR|KR|CARRERA|DG|DIAGONAL|TV|TRANSVERSAL|AV|AVENIDA|AK|AC|AUTOPISTA|CIRCULAR|MANZANA|MZ|KM|KILOMETRO)\b|\b\d+\s*(?:#|NO\.?|NUMERO)\s*\d+/i;

  let bestCol: string | null = null;
  let bestScore = 0;

  for (const h of headers) {
    let matchCount = 0;
    let totalNonEmpty = 0;
    for (const r of sample) {
      const val = String(r[h] || '').trim();
      if (!val) continue;
      totalNonEmpty++;
      if (ADDR_PATTERN.test(val)) matchCount++;
    }
    if (totalNonEmpty >= 2) {
      const ratio = matchCount / totalNonEmpty;
      if (ratio >= 0.35 && ratio > bestScore) {
        bestScore = ratio;
        bestCol = h;
      }
    }
  }
  return bestCol;
}

export function findColSmart(headers: string[], key: string, sampleRows: any[] | null = null): string | null {
  if (!Array.isArray(headers)) return null;

  const patterns = CM_PATTERNS[key] || [];
  for (const p of patterns) {
    const f = headers.find(h => p.test(String(h || '').trim()));
    if (f) return f;
  }

  const targetNorm = normClean((CM_DEFAULTS as any)[key]);

  if (key === 'addr') {
    const directAddr = headers.find(h => {
      const n = normClean(h);
      if (!n) return false;
      return (
        n.startsWith('dir') ||
        n.includes('direc') ||
        n.includes('domicil') ||
        n.includes('nomenclat') ||
        n.includes('ubicac') ||
        n.includes('ptoentrega') ||
        n.includes('puntoentrega') ||
        n.includes('destinofisico') ||
        n.includes('lugarentrega') ||
        n.includes('calle') ||
        n.includes('carrera') ||
        n.includes('address') ||
        n.includes('street')
      );
    });
    if (directAddr) return directAddr;

    const typoAddr = headers.find(h => {
      const n = normClean(h);
      if (!n || n.length < 4) return false;
      const sub = n.slice(0, 9);
      return levenshteinDistance(sub, 'direccion') <= 2 || levenshteinDistance(n, 'domicilio') <= 2;
    });
    if (typoAddr) return typoAddr;

    if (sampleRows && sampleRows.length) {
      const contentCol = detectAddressColByContent(headers, sampleRows);
      if (contentCol) return contentCol;
    }
  }

  const general = headers.find(h => {
    const n = normClean(h);
    if (!n) return false;
    return n === targetNorm || n.includes(targetNorm) || (targetNorm.length >= 5 && targetNorm.includes(n));
  });
  if (general) return general;

  if (targetNorm.length >= 5) {
    const fuzzy = headers.find(h => {
      const n = normClean(h);
      if (!n || Math.abs(n.length - targetNorm.length) > 3) return false;
      return levenshteinDistance(n, targetNorm) <= 2;
    });
    if (fuzzy) return fuzzy;
  }

  return null;
}

export function findCol(h: string[], t: string): string | null {
  if (!Array.isArray(h)) return null;
  const target = t.toLowerCase().trim().replace(/\s+/g, ' ');
  const targetNorm = normClean(t);
  return h.find(x => {
    const s = String(x || '').toLowerCase().trim().replace(/\s+/g, ' ');
    return s === target || normClean(x) === targetNorm;
  }) || null;
}

export function extractSheetData(wb: any): { rows: any[]; headers: string[]; sheetName: string } {
  if (!wb || !wb.SheetNames || !wb.SheetNames.length) return { rows: [], headers: [], sheetName: '' };

  let bestSheetName = wb.SheetNames[0];
  let bestRows: any[] = [];
  let bestHeaders: string[] = [];
  let bestScore = -1;

  for (const sName of wb.SheetNames) {
    const sheet = wb.Sheets[sName];
    if (!sheet) continue;

    const standardRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (standardRows.length > 0) {
      const h = Object.keys(standardRows[0]);
      let score = 0;
      if (findColSmart(h, 'addr', standardRows)) score += 10;
      ['order', 'id', 'name', 'city', 'neigh', 'phone', 'volume'].forEach(k => {
        if (findColSmart(h, k, standardRows)) score += 2;
      });
      if (score > bestScore && score >= 2) {
        bestScore = score;
        bestSheetName = sName;
        bestRows = standardRows;
        bestHeaders = h;
        if (score >= 10) break;
      }
    }

    const matrix: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    for (let r = 0; r < Math.min(matrix.length, 12); r++) {
      const candidateHeaders = (matrix[r] || []).map(x => String(x || '').trim());
      if (candidateHeaders.filter(Boolean).length < 2) continue;

      let score = 0;
      if (findColSmart(candidateHeaders, 'addr')) score += 10;
      ['order', 'id', 'name', 'city', 'neigh', 'phone', 'volume'].forEach(k => {
        if (findColSmart(candidateHeaders, k)) score += 2;
      });

      if (score > bestScore && score >= 2) {
        const dataRows: any[] = [];
        for (let d = r + 1; d < matrix.length; d++) {
          const rowArr = matrix[d] || [];
          if (!rowArr.some(cell => String(cell || '').trim() !== '')) continue;
          const obj: Record<string, string> = {};
          candidateHeaders.forEach((colName, cIdx) => {
            if (colName) obj[colName] = String(rowArr[cIdx] || '').trim();
          });
          dataRows.push(obj);
        }
        if (dataRows.length > 0) {
          bestScore = score;
          bestSheetName = sName;
          bestRows = dataRows;
          bestHeaders = candidateHeaders.filter(Boolean);
          if (score >= 10) break;
        }
      }
    }
  }

  if (!bestRows.length && wb.SheetNames.length > 0) {
    const sName = wb.SheetNames[0];
    const sheet = wb.Sheets[sName];
    if (sheet) {
      bestRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
      bestHeaders = Object.keys(bestRows[0] || {});
      bestSheetName = sName;
    }
  }

  return { rows: bestRows, headers: bestHeaders, sheetName: bestSheetName };
}

export function keyDest(d: any): string {
  const a = normText(d.direccion);
  const ci = normText(d.ciudad);
  return [a, ci].join('|');
}

export function preprocess(rows: any[], cm: any): {
  destinations: PhysicalDestination[];
  stats: PreprocessStats;
  orders: OrderItem[];
  excludedRows: any[];
} {
  const stats: PreprocessStats = {
    rows: rows.length,
    cityExcluded: 0,
    freightExcluded: 0,
    cendisExcluded: 0,
    branchHomologated: 0,
    corrected: {},
    cities: {},
    orders: 0,
    destinations: 0,
    excludedRows: []
  };

  const valid: any[] = [];

  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    const rawName = cm.name ? String(r[cm.name] || '').trim() : '';
    const rawAddr = cm.addr ? String(r[cm.addr] || '').trim() : '';
    const rawNeigh = cm.neigh ? String(r[cm.neigh] || '').trim() : '';
    const rawDesc = cm.desc ? String(r[cm.desc] || '').trim().toUpperCase() : '';

    if (!rawAddr) {
      stats.excludedRows.push({ ...r, _motivo: 'Fila sin dirección registrada' });
      continue;
    }

    if (isCendisBogota(rawName, rawAddr, rawNeigh, rawDesc)) {
      stats.cendisExcluded++;
      stats.excludedRows.push({ ...r, _motivo: 'Exclusión Cendis Bogotá (Punto de salida / depósito central)' });
      continue;
    }

    const branchInfo = getJamarBranchAddress(rawName) || getJamarBranchAddress(rawAddr);
    if (branchInfo) {
      r[cm.addr] = branchInfo.address;
      if (cm.city) r[cm.city] = 'BOGOTA';
      r._jamarBranch = branchInfo.branchKey;
      stats.branchHomologated++;
    }

    let city = cm.city ? String(r[cm.city] || '').trim().toUpperCase() : 'BOGOTA';
    if (!city) city = 'BOGOTA';
    city = city.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();

    if (CORRECTIONS[city]) {
      stats.corrected[city] = (stats.corrected[city] || 0) + 1;
      city = CORRECTIONS[city];
      if (cm.city) r[cm.city] = city;
    }

    if (city.includes('BOGOTA') || city === 'D.C' || city === 'DC' || city === 'CAPITAL') {
      city = 'BOGOTA';
      if (cm.city) r[cm.city] = city;
    }

    const OUT_OF_COVERAGE = new Set(['MEDELLIN', 'CALI', 'BARRANQUILLA', 'CARTAGENA', 'BUCARAMANGA', 'PEREIRA', 'MANIZALES', 'ARMENIA', 'SANTA MARTA', 'CUCUTA', 'IBAGUE', 'VALLEDUPAR', 'MONTERIA', 'PASTO', 'VILLAVICENCIO', 'NEIVA']);
    if (OUT_OF_COVERAGE.has(city)) {
      stats.cityExcluded++;
      stats.cities[city] = (stats.cities[city] || 0) + 1;
      stats.excludedRows.push({ ...r, _motivo: 'Ciudad fuera de cobertura metropolitana: ' + city });
      continue;
    } else if (!CITIES.has(city)) {
      city = 'BOGOTA';
      if (cm.city) r[cm.city] = city;
    }

    if (rawDesc === 'SERVICIO DE FLETE') {
      stats.freightExcluded++;
      stats.excludedRows.push({ ...r, _motivo: 'Servicio de flete excluido' });
      continue;
    }

    let v = 0;
    if (cm.volume && r[cm.volume] !== undefined && r[cm.volume] !== '') {
      const vRaw = String(r[cm.volume]).replace(',', '.').trim();
      v = parseFloat(vRaw) || 0;
    }
    if (v <= 0) {
      v = 0.1;
    }

    valid.push({ ...r, _parsedVol: v, _rowIndex: idx + 1, _resolvedCity: city });
  }

  const orders: Record<string, any> = {};
  for (const r of valid) {
    let k = cm.order ? String(r[cm.order] || '').trim() : '';
    if (!k) {
      k = cm.id && r[cm.id] ? `PED-${String(r[cm.id]).trim()}` : `PED-${r._rowIndex}`;
    }

    if (!orders[k]) {
      const rawName = cm.name ? String(r[cm.name] || '').trim() : `Cliente ${r._rowIndex}`;
      const rawId = cm.id ? String(r[cm.id] || '').trim() : `DOC-${r._rowIndex}`;
      const rawNeigh = cm.neigh ? String(r[cm.neigh] || '').trim() : 'Sector Urbano';
      const rawCity = r._resolvedCity || 'BOGOTA';
      const rawPhone = cm.phone ? String(r[cm.phone] || '').trim() : '';

      const branchInfo = r._jamarBranch ? { branchKey: r._jamarBranch, address: r[cm.addr] } : (getJamarBranchAddress(rawName) || getJamarBranchAddress(r[cm.addr]));
      const rawAddrToUse = branchInfo ? branchInfo.address : r[cm.addr];
      const n = normalizeAddress(rawAddrToUse);

      orders[k] = {
        pedido: k,
        cliente: rawName || `Cliente ${r._rowIndex}`,
        cedula: rawId || `DOC-${r._rowIndex}`,
        direccionOriginal: rawAddrToUse,
        direccion: n.clean,
        complemento: n.complement || (branchInfo ? branchInfo.branchKey : ''),
        barrio: branchInfo ? branchInfo.branchKey : (rawNeigh || 'Sector Urbano'),
        ciudad: branchInfo ? 'BOGOTA' : rawCity,
        telefono: rawPhone,
        vol: 0,
        items: 0,
        found: n.found
      };
    }
    orders[k].vol += r._parsedVol;
    orders[k].items++;
  }

  const destMap: Record<string, any> = {};
  Object.values(orders).forEach((o: any) => {
    o.vol = Math.round(o.vol * 1000) / 1000;
    const k = keyDest(o);
    if (!destMap[k]) {
      destMap[k] = {
        ...o,
        vol: 0,
        pedidos: [],
        entregas: [],
        numOrders: 0
      };
    }
    destMap[k].entregas.push({
      pedido: o.pedido,
      cliente: o.cliente,
      cedula: o.cedula,
      complemento: o.complemento || '',
      direccionOriginal: o.direccionOriginal,
      vol: o.vol,
      telefono: o.telefono || '',
      items: o.items || 1
    });

    if (!destMap[k].pedidos.includes(o.pedido)) {
      destMap[k].vol += o.vol;
      destMap[k].pedidos.push(o.pedido);
      destMap[k].numOrders++;
    }
  });

  const destinations: PhysicalDestination[] = Object.values(destMap).map((d: any, i: number) => {
    const isMultiDelivery = d.entregas && d.entregas.length > 1;
    let clienteDisplay = d.cliente;
    if (isMultiDelivery) {
      const distinctClients = Array.from(new Set(d.entregas.map((e: any) => e.cliente)));
      clienteDisplay = distinctClients.length > 1
        ? `${d.entregas.length} entregas: ${distinctClients.join(' · ')}`
        : `${distinctClients[0]} (${d.entregas.length} entregas)`;
    }

    const dest: PhysicalDestination = {
      ...d,
      id: i,
      key: keyDest(d),
      cliente: clienteDisplay,
      vol: Math.round(d.vol * 1000) / 1000,
      lat: null,
      lng: null,
      status: 'OK',
      confidence: 'pending',
      strategy: 'Pendiente',
      zone: ''
    };
    dest.zone = classifyZone(dest);
    return dest;
  });

  stats.orders = Object.keys(orders).length;
  stats.destinations = destinations.length;

  return { destinations, stats, orders: Object.values(orders), excludedRows: stats.excludedRows };
}

export function generateCorrectedRows(rows: any[], addrCol: string): any[] {
  return rows.map(r => {
    let rawAddr = String(r[addrCol] || '').trim();
    const h = Object.keys(r);
    const nameCol = findCol(h, 'Cliente') || findCol(h, 'Nombre') || h.find(k => /cliente|nombre/i.test(k));
    const clientName = nameCol ? String(r[nameCol] || '') : '';
    const branchInfo = getJamarBranchAddress(rawAddr) || getJamarBranchAddress(clientName);
    if (branchInfo) {
      rawAddr = branchInfo.address;
    }

    const norm = normalizeAddress(rawAddr);
    const newObj: Record<string, any> = {};
    let inserted = false;
    for (const [k, v] of Object.entries(r)) {
      newObj[k] = v;
      if (k === addrCol) {
        newObj['Dirección Corregida'] = norm.clean || rawAddr;
        newObj['Complemento'] = norm.complement || '';
        if (branchInfo) {
          newObj['Homologación Jamar'] = branchInfo.branchKey;
        }
        inserted = true;
      }
    }
    if (!inserted) {
      newObj['Dirección Corregida'] = norm.clean || rawAddr;
      newObj['Complemento'] = norm.complement || '';
      if (branchInfo) {
        newObj['Homologación Jamar'] = branchInfo.branchKey;
      }
    }
    return newObj;
  });
}

/**
 * Actualiza la vista previa de muestras en vivo del modal de mapeo de columnas
 */
export function updateColMapSamples(selectedCol: string, rows: any[]): void {
  const container = document.getElementById('colMapAddrSamples');
  if (!container) return;
  if (!selectedCol) {
    container.innerHTML = '<span class="text-slate-400 italic">Selecciona una columna para previsualizar valores.</span>';
    return;
  }
  const samples: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const val = String(rows[i][selectedCol] || '').trim();
    if (val && !samples.includes(val)) {
      samples.push(val);
      if (samples.length >= 3) break;
    }
  }
  if (!samples.length) {
    container.innerHTML = '<span class="text-amber-600 dark:text-amber-400">⚠️ Esta columna no tiene valores en las primeras filas.</span>';
  } else {
    container.innerHTML = samples.map((s, idx) => `
      <div class="truncate text-[11px] flex items-center gap-1.5">
        <span class="text-slate-400 font-sans text-[10px]">#${idx + 1}:</span>
        <span class="font-semibold text-slate-800 dark:text-slate-200">${esc(s)}</span>
      </div>
    `).join('');
  }
}

/**
 * Despliega el modal visual interactivo para mapear columnas del archivo Excel
 */
export function showColumnMappingModal(rows: any[], headers: string[], currentCm: any, onConfirmCallback: (cm: any) => void): void {
  const modal = document.getElementById('columnMappingModal');
  const addrSelect = document.getElementById('colMapAddrSelect') as HTMLSelectElement | null;
  if (!modal || !addrSelect) return;

  // Llenar select de Dirección
  const detectedAddr = currentCm.addr || findColSmart(headers, 'addr', rows) || '';
  addrSelect.innerHTML = `
    <option value="" ${!detectedAddr ? 'selected' : ''}>-- Selecciona la columna de Dirección --</option>
    ${headers.map(h => `<option value="${esc(h)}" ${h === detectedAddr ? 'selected' : ''}>${esc(h)}</option>`).join('')}
  `;
  updateColMapSamples(addrSelect.value, rows);

  addrSelect.onchange = () => {
    updateColMapSamples(addrSelect.value, rows);
  };

  // Mapear campos opcionales secundarios
  const optionalMap = [
    { id: 'colMapNameSelect', key: 'name' },
    { id: 'colMapOrderSelect', key: 'order' },
    { id: 'colMapIdSelect', key: 'id' },
    { id: 'colMapCitySelect', key: 'city' },
    { id: 'colMapNeighSelect', key: 'neigh' },
    { id: 'colMapPhoneSelect', key: 'phone' },
    { id: 'colMapVolumeSelect', key: 'volume' },
    { id: 'colMapDescSelect', key: 'desc' }
  ];

  optionalMap.forEach(({ id, key }) => {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel) return;
    const curVal = currentCm[key] || findColSmart(headers, key, rows) || '';
    sel.innerHTML = `
      <option value="">(No asignado / Opcional)</option>
      ${headers.map(h => `<option value="${esc(h)}" ${h === curVal ? 'selected' : ''}>${esc(h)}</option>`).join('')}
    `;
  });

  // Toggle de campos avanzados
  const toggleBtn = document.getElementById('toggleColMapAdvancedBtn');
  const advSec = document.getElementById('colMapAdvancedSection');
  const advArrow = document.getElementById('colMapAdvancedArrow');
  if (toggleBtn && advSec && advArrow) {
    toggleBtn.onclick = () => {
      const isHidden = advSec.classList.contains('hidden');
      if (isHidden) {
        advSec.classList.remove('hidden');
        advArrow.textContent = '▴';
      } else {
        advSec.classList.add('hidden');
        advArrow.textContent = '▾';
      }
    };
  }

  // Cerrar y Cancelar
  const closeModal = () => {
    modal.classList.add('hidden');
  };
  const closeBtn = document.getElementById('closeColMapModalBtn');
  if (closeBtn) closeBtn.onclick = closeModal;
  const cancelBtn = document.getElementById('colMapCancelBtn');
  if (cancelBtn) cancelBtn.onclick = closeModal;

  // Confirmar
  const confirmBtn = document.getElementById('colMapConfirmBtn');
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      const chosenAddr = addrSelect.value;
      if (!chosenAddr) {
        toast('Por favor selecciona la columna de Dirección para continuar.', 'warn');
        addrSelect.focus();
        return;
      }

      const updatedCm: Record<string, any> = {
        addr: chosenAddr,
        name: (document.getElementById('colMapNameSelect') as HTMLSelectElement)?.value || null,
        order: (document.getElementById('colMapOrderSelect') as HTMLSelectElement)?.value || null,
        id: (document.getElementById('colMapIdSelect') as HTMLSelectElement)?.value || null,
        city: (document.getElementById('colMapCitySelect') as HTMLSelectElement)?.value || null,
        neigh: (document.getElementById('colMapNeighSelect') as HTMLSelectElement)?.value || null,
        phone: (document.getElementById('colMapPhoneSelect') as HTMLSelectElement)?.value || null,
        volume: (document.getElementById('colMapVolumeSelect') as HTMLSelectElement)?.value || null,
        desc: (document.getElementById('colMapDescSelect') as HTMLSelectElement)?.value || null
      };

      closeModal();
      if (typeof onConfirmCallback === 'function') {
        onConfirmCallback(updatedCm);
      }
    };
  }

  modal.classList.remove('hidden');
}

if (typeof window !== 'undefined') {
  (window as any).showColumnMappingModal = showColumnMappingModal;
}

