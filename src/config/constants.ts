import { DepotLocation } from '../types';

/**
 * Punto de partida fijo: Depósito Cendis Siberia / Funza
 */
export const DEPOT: DepotLocation = {
  lat: 4.762388931922002,
  lng: -74.16165735180336
};

// Límites máximos permitidos (topes estructurales de seguridad)
export const MAX_VOL = 18;
export const MAX_DEST = 15;

// Parámetros para Ruta Cómoda y Balanceada (distribución equitativa sin sobrecargar)
export const COMFORT = {
  TARGET_DEST: 9,      // Meta cómoda promedio de clientes por ruta
  SOFT_MAX_DEST: 11,   // Límite de crecimiento de semilla para dar cabida a rutas equilibradas
  TARGET_VOL: 12.5,    // Meta cómoda promedio de volumen (m³)
  SOFT_MAX_VOL: 14.0   // Límite de volumen para crecimiento inicial
};

export const MIN_VOL = 10;   // Mínimo deseado de carga para balanceo
export const MIN_DEST = 7;   // Mínimo deseado de clientes para balanceo

// Ciudades y municipios autorizados para ruteo local
export const CITIES = new Set([
  'BOGOTA', 'SOACHA', 'MADRID', 'MOSQUERA', 'FACATATIVA',
  'LA CALERA', 'CHIA', 'COTA', 'FUNZA', 'CAJICA', 'SIBATE', 'EL ROSAL',
  'TENJO', 'TABIO', 'SOPO', 'TOCANCIPA', 'GACHANCIPA'
]);

// Correcciones automáticas de nomenclatura municipal
export const CORRECTIONS: Record<string, string> = {
  'AGUA DE DIOS': 'FUNZA',
  'SOPO CUNDINAMARCA': 'SOPO',
  'TOCANCIPA CUNDINAMARCA': 'TOCANCIPA',
  'GACHANCIPA CUNDINAMARCA': 'GACHANCIPA'
};

// Diccionario de homologación de tiendas Jamar y sus direcciones físicas exactas en Bogotá
export const JAMAR_BRANCH_ADDRESSES: Record<string, string> = {
  'JAMAR CRA 30': 'Carrera 32 No. 17B - 04',
  'JAMAR LAS AMERICAS': 'Carrera 71D # 6-94 Sur',
  'JAMAR EL EDEN': 'Avenida Boyacá con Calle 12B #71D - 31',
  'JAMAR NORTE': 'Cra. 45 #192 - 18'
};

// Parámetros de Operación y Tiempos de Entrega Jamar
export const LOGISTICS = {
  START_TIME_MINUTES: 7 * 60 + 30, // 07:30 AM (hora de salida en minutos desde medianoche)
  MAX_END_TIME_MINUTES: 17 * 60,    // 17:00 (5:00 PM - hora referencial de guía)
  BASE_SPEED_KMH: 22,               // Velocidad promedio ponderada en tráfico metropolitano
  BASE_STOP_MINUTES: 18,            // Tiempo base por parada (parqueo, recepción, remisión)
  MINUTES_PER_M3: 6                 // Tiempo adicional de descargue y armado básico según volumen
};

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';

/**
 * Factor de sinuosidad vial urbana para Bogotá y Sabana:
 * En malla urbana colombiana (manzanas, giros obligados, retornos y sentidos viales),
 * la distancia real por carretera/calle es un 32% superior a la línea recta geodésica.
 */
export const ROAD_CIRCUITY_FACTOR = 1.32;

// Control de cuota diaria de Google Maps (silencioso en segundo plano)
export const DAILY_GMAPS_LIMIT = 1000;
export const GMAPS_WARN_THRESHOLD = DAILY_GMAPS_LIMIT - 100;

export const DEFAULT_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed',
  '#0891b2', '#db2777', '#b45309', '#4338ca', '#65a30d',
  '#0d9488', '#991b1b', '#c026d3', '#d97706', '#047857',
  '#9333ea', '#f43f5e', '#1e3a8a', '#4d7c0f', '#334155'
];
