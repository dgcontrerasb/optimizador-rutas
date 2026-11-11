import { PhysicalDestination } from '../types';

export function normalizeInsensitive(str: any): string {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

export function normText(x: any): string {
  return String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hav(a: number, b: number, c: number, d: number): number {
  const R = 6371, p = Math.PI / 180;
  const A = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(A));
}

/**
 * Clasificación de Macro-Zonas Logísticas Inteligente:
 * - 'SABANA_OCCIDENTE': Funza, Mosquera, Madrid, Facatativá, El Rosal
 * - 'SABANA_NORTE': Chía, Cota, Cajicá, Tenjo, Tabio, Sopó, Tocancipá, Gachancipá, La Calera
 * - 'SOACHA_SUR': Soacha, Sibaté
 * 
 * Macrosectores Urbanos de Bogotá:
 * - 'BOGOTA_SUR_ALTO': Cerros y zonas altas de Ciudad Bolívar / Usme
 * - 'BOGOTA_SUR': Kennedy, Bosa, Carvajal, Tunjuelito, Américas Sur, etc.
 * - 'BOGOTA_NORTE': Suba, Usaquén, Cedritos, San Cristóbal Norte, Mazurén, etc.
 * - 'BOGOTA_OCCIDENTE': Engativá, Álamos, Fontibón, Modelia, Salitre, etc.
 * - 'BOGOTA_CENTRO_ORIENTE': Chapinero, Teusaquillo, Barrios Unidos, Santa Fe, etc.
 */
export function classifyZone(d: Partial<PhysicalDestination>): string {
  const city = normText(d.ciudad);
  const dir = normText(d.direccionOriginal || d.direccion);
  const bar = normText(d.barrio);
  const full = `${city} ${dir} ${bar}`;
  const lat = (d && typeof d.lat === 'number' && Number.isFinite(d.lat)) ? d.lat : null;
  const lng = (d && typeof d.lng === 'number' && Number.isFinite(d.lng)) ? d.lng : null;

  // 1. Sabana Occidente (Municipios intermunicipales occidente)
  if (['FUNZA', 'MOSQUERA', 'MADRID', 'FACATATIVA', 'EL ROSAL'].includes(city)) {
    return 'SABANA_OCCIDENTE';
  }
  // 2. Sabana Norte Ampliada (Norte metropolitano y corredor norte)
  if (['CHIA', 'COTA', 'CAJICA', 'TENJO', 'TABIO', 'SOPO', 'TOCANCIPA', 'GACHANCIPA', 'LA CALERA'].includes(city)) {
    return 'SABANA_NORTE';
  }
  // 3. Soacha y Sibaté
  if (['SOACHA', 'SIBATE'].includes(city)) {
    return 'SOACHA_SUR';
  }

  // 4. Bogotá y localidades
  // A. Montaña Sur / Zonas Altas de Ciudad Bolívar, Rafael Uribe y Usme
  if (
    full.includes('LA PAZ') || full.includes('PERDOMO ALTO') || full.includes('ARBORIZADORA ALTA') ||
    full.includes('SIERRA MORENA') || full.includes('JERUSALEN') || full.includes('MEISSEN') ||
    full.includes('LUCERO') || full.includes('USME') || full.includes('CAZUCA ALTO') ||
    full.includes('ALTOS DE CAZUCA') || full.includes('EL MOCHUELO') || full.includes('MONTEBLANCO') ||
    (lat !== null && lng !== null && lat < 4.565 && lng > -74.15)
  ) {
    return 'BOGOTA_SUR_ALTO';
  }

  // B. Bogotá Norte (Suba, Usaquén y corredor norte de la ciudad)
  if (
    full.includes('SUBA') || full.includes('USAQUEN') || full.includes('CEDRITOS') ||
    full.includes('SAN CRISTOBAL NORTE') || full.includes('MAZUREN') || full.includes('COLINA') ||
    full.includes('NIZA') || full.includes('PRADO VERANIEGO') || full.includes('TOBERIN') ||
    full.includes('RINCON DE SUBA') || full.includes('TIBABUYES') || full.includes('LOMBARDIA') ||
    full.includes('PINAR DE SUBA') || full.includes('SAN CARLOS SUBA') || full.includes('CAMPANELA') ||
    full.includes('LISBOA') || full.includes('CANTALEJO') || full.includes('MIRANDELA') ||
    full.includes('SAN JOSE DE BAVARIA') || full.includes('CALLE 170') || full.includes('CALLE 187') ||
    full.includes('CALLE 134') || full.includes('CALLE 127') ||
    (lat !== null && lat >= 4.715)
  ) {
    return 'BOGOTA_NORTE';
  }

  // C. Bogotá Occidente (Engativá, Álamos, Fontibón, Modelia, Salitre, Minuto de Dios, Villas de Granada)
  if (
    full.includes('ENGATIVA') || full.includes('FONTIBON') || full.includes('MODELIA') ||
    full.includes('HAYUELOS') || full.includes('ALAMOS') || full.includes('MINUTO DE DIOS') ||
    full.includes('QUIRIGUA') || full.includes('VILLAS DE GRANADA') || full.includes('NORMANDIA') ||
    full.includes('CAPELLANIA') || full.includes('VILLEMAR') || full.includes('SAN PABLO FONTIBON') ||
    full.includes('SALITRE OCCIDENTE') || full.includes('BONANZA') || full.includes('GARCES NAVAS') ||
    full.includes('FLORIDA') || full.includes('LA SERENA') || full.includes('BOCHICA') ||
    full.includes('SANTA HELENITA') || full.includes('FERIAS') || full.includes('ESTRADA') ||
    full.includes('VILLA LUZ') || full.includes('CALLE 26') || full.includes('AVENIDA ESPERANZA') ||
    full.includes('CRA 89B') || full.includes('CARRERA 89B') || full.includes('CR 89B') ||
    (lat !== null && lng !== null && lat >= 4.635 && lat < 4.715 && lng <= -74.095)
  ) {
    return 'BOGOTA_OCCIDENTE';
  }

  // D. Bogotá Sur y Suroccidente (Kennedy, Bosa, Carvajal, Tunjuelito, Américas Sur, Perdomo, etc.)
  if (
    full.includes('BOSA') || full.includes('KENNEDY') || full.includes('CARVAJAL') ||
    full.includes('PERDOMO') || full.includes('TUNJUELITO') || full.includes('CANDELARIA LA NUEVA') ||
    full.includes('ARBORIZADORA') || full.includes('PATIO BONITO') || full.includes('TINTAL') ||
    full.includes('CASTILLA SUR') || full.includes('ROMA') || full.includes('VILLA DEL RIO') ||
    full.includes('TIMIZA') || full.includes('MANDALAY') || full.includes('AMERICAS') ||
    full.includes('ALQUERIA') || full.includes('FATIMA') || full.includes('VENECIA') ||
    full.includes('SAN CARLOS') || full.includes('CIUDAD BOLIVAR') ||
    (full.includes(' SUR ') || full.endsWith(' SUR')) ||
    (lat !== null && lng !== null && lat <= 4.635 && lng <= -74.105)
  ) {
    return 'BOGOTA_SUR';
  }

  // E. Bogotá Centro-Oriente (Chapinero, Teusaquillo, Barrios Unidos, Centro, Santa Fe, La Candelaria)
  if (
    full.includes('CHAPINERO') || full.includes('TEUSAQUILLO') || full.includes('BARRIOS UNIDOS') ||
    full.includes('SANTA FE') || full.includes('CANDELARIA') || full.includes('CENTRO') ||
    full.includes('PALERMO') || full.includes('GALERIAS') || full.includes('CHICO') ||
    full.includes('ROSALES') || full.includes('MACARENA') || full.includes('SAMPER MENDOZA') ||
    full.includes('7 DE AGOSTO') || full.includes('POLO CLUB') ||
    (lat !== null && lng !== null && lat >= 4.585 && lat < 4.715 && lng > -74.095)
  ) {
    return 'BOGOTA_CENTRO_ORIENTE';
  }

  // Fallback según coordenadas disponibles o defecto
  if (lat !== null) {
    if (lat >= 4.715) return 'BOGOTA_NORTE';
    if (lat <= 4.635) return 'BOGOTA_SUR';
    if (lng !== null && lng > -74.095) return 'BOGOTA_CENTRO_ORIENTE';
    return 'BOGOTA_OCCIDENTE';
  }

  return 'BOGOTA_OCCIDENTE';
}

export function isElRosal(d: Partial<PhysicalDestination>): boolean {
  const c = normText(d.ciudad);
  const full = normText(`${d.direccionOriginal || ''} ${d.barrio || ''} ${d.ciudad || ''}`);
  return c === 'EL ROSAL' || full.includes('EL ROSAL');
}

/**
 * Validador de compatibilidad geográfica inteligente y elástica
 */
export function isZoneCompatible(existingStops: PhysicalDestination[], candidate: PhysicalDestination): boolean {
  if (!existingStops || !existingStops.length) return true;
  const candZone = candidate.zone || classifyZone(candidate);
  const existingZones = new Set(existingStops.map(s => s.zone || classifyZone(s)));

  if (existingZones.size === 1 && existingZones.has(candZone)) return true;

  const hasSabanaOcc = existingZones.has('SABANA_OCCIDENTE') || candZone === 'SABANA_OCCIDENTE';
  const hasSabanaNorte = existingZones.has('SABANA_NORTE') || candZone === 'SABANA_NORTE';
  const hasSoacha = existingZones.has('SOACHA_SUR') || candZone === 'SOACHA_SUR';
  const hasBogotaNorte = existingZones.has('BOGOTA_NORTE') || candZone === 'BOGOTA_NORTE';
  const hasBogotaOcc = existingZones.has('BOGOTA_OCCIDENTE') || candZone === 'BOGOTA_OCCIDENTE';
  const hasBogotaSur = existingZones.has('BOGOTA_SUR') || candZone === 'BOGOTA_SUR';
  const hasSurAlto = existingZones.has('BOGOTA_SUR_ALTO') || candZone === 'BOGOTA_SUR_ALTO';
  const hasCentroOriente = existingZones.has('BOGOTA_CENTRO_ORIENTE') || candZone === 'BOGOTA_CENTRO_ORIENTE';

  // 1. Prohibiciones absolutas con Sabana Norte
  if (hasSabanaNorte && (hasSabanaOcc || hasSoacha || hasBogotaSur || hasSurAlto || hasCentroOriente || hasBogotaOcc)) {
    return false;
  }

  // 2. Montaña sur (BOGOTA_SUR_ALTO)
  if (hasSurAlto && (hasSabanaNorte || hasSabanaOcc || hasSoacha || hasBogotaNorte || hasBogotaOcc || hasCentroOriente)) {
    return false;
  }

  // 3. Regla Sabana Norte
  if (hasSabanaNorte) {
    if (hasBogotaOcc || hasBogotaSur || hasSurAlto || hasCentroOriente || hasSabanaOcc || hasSoacha) return false;
    return true;
  }

  // 4. Regla Sabana Occidente + Soacha
  if (hasSabanaOcc && hasSoacha) {
    if (hasBogotaNorte || hasCentroOriente || hasSurAlto || hasBogotaOcc) return false;
    const hasFarWest = existingStops.some(s => {
      const c = normText(s.ciudad);
      return c === 'FACATATIVA' || c === 'EL ROSAL';
    }) || ['FACATATIVA', 'EL ROSAL'].includes(normText(candidate.ciudad));
    if (hasFarWest) return false;
    return true;
  }

  // 5. Regla Sabana Occidente (sin Soacha)
  if (hasSabanaOcc) {
    if (hasBogotaNorte || hasBogotaSur || hasSurAlto || hasCentroOriente) return false;
    if (hasBogotaOcc) {
      const anyElRosal = existingStops.some(isElRosal) || isElRosal(candidate);
      if (anyElRosal) return false;
    }
    return true;
  }

  // 6. Regla Soacha
  if (hasSoacha) {
    if (hasBogotaNorte || hasBogotaOcc || hasCentroOriente || hasSurAlto) return false;
    return true;
  }

  // 7. PROHIBICIÓN ABSOLUTA: BOGOTA_NORTE con BOGOTA_SUR o BOGOTA_SUR_ALTO
  if (hasBogotaNorte && (hasBogotaSur || hasSurAlto)) return false;

  // 8. BOGOTA_OCCIDENTE con BOGOTA_SUR: Bloquear saltos > 3.5 km
  if (hasBogotaOcc && hasBogotaSur) {
    if (candidate.lat && candidate.lng && existingStops.some(s => s.lat && s.lng)) {
      const validStops = existingStops.filter(s => s.lat && s.lng);
      const minD = Math.min(...validStops.map(s => hav(s.lat!, s.lng!, candidate.lat!, candidate.lng!)));
      if (minD > 3.5) return false;
    } else {
      return false;
    }
  }

  // 9. BOGOTA_NORTE con BOGOTA_OCCIDENTE: Distancia <= 5.0 km
  if (hasBogotaNorte && hasBogotaOcc) {
    if (candidate.lat && candidate.lng && existingStops.some(s => s.lat && s.lng)) {
      const validStops = existingStops.filter(s => s.lat && s.lng);
      const minD = Math.min(...validStops.map(s => hav(s.lat!, s.lng!, candidate.lat!, candidate.lng!)));
      if (minD > 5.0) return false;
    }
  }

  // 10. BOGOTA_CENTRO_ORIENTE con BOGOTA_SUR o BOGOTA_OCCIDENTE: Distancia <= 5.5 km
  if (hasCentroOriente) {
    if (candidate.lat && candidate.lng && existingStops.some(s => s.lat && s.lng)) {
      const validStops = existingStops.filter(s => s.lat && s.lng);
      const minD = Math.min(...validStops.map(s => hav(s.lat!, s.lng!, candidate.lat!, candidate.lng!)));
      if (minD > 5.5) return false;
    }
  }

  return true;
}
