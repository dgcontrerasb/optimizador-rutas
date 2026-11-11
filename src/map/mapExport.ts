import { DEPOT } from '../config/constants';
import { S, toast } from '../state/store';
import { active } from '../services/routing';

declare const html2canvas: any;
declare const L: any;

/**
 * =========================================================================
 * Descarga del Mapa en Imagen (PNG) con html2canvas en Alta Definición y Autoajuste
 * IMPLEMENTACIÓN 100% INTACTA
 * =========================================================================
 */
export async function downloadMapAsPng(): Promise<void> {
  const mapElement = document.getElementById('map');
  const mapWrap = document.getElementById('mapWrap');
  if (!mapElement || !S.map) {
    toast('No hay mapa disponible para capturar', 'warn');
    return;
  }
  toast('Preparando encuadre y captura completa del mapa...', 'info');

  // a) Oculta los controles de UI flotantes durante la captura
  if (mapWrap) mapWrap.classList.add('capturing-map');
  document.body.classList.add('capturing-map');

  // Guardar la vista actual del usuario para restaurarla tras la captura
  const prevCenter = S.map.getCenter();
  const prevZoom = S.map.getZoom();

  try {
    // b) Recopilar coordenadas de todas las paradas activas y depósito para encuadre 100% completo
    const allCoords: [number, number][] = [[DEPOT.lat, DEPOT.lng]];
    if (S.viewMode === 'all' || S.currentRouteIndex === -1) {
      const visibleRoutes = (S.routes || []).filter(r => r.visible !== false);
      const targetRoutes = visibleRoutes.length ? visibleRoutes : (S.routes || []);
      targetRoutes.forEach(r => {
        const st = active(r) || [];
        st.forEach(d => {
          if (d.lat && d.lng) allCoords.push([d.lat, d.lng]);
        });
      });
    } else {
      const cur = (S.routes || []).find(r => r.id === S.currentRouteIndex);
      if (cur) {
        const st = active(cur) || [];
        st.forEach(d => {
          if (d.lat && d.lng) allCoords.push([d.lat, d.lng]);
        });
      }
    }

    // Detectar si está en modo pantalla completa (API nativa o clase activa)
    const isFs = Boolean(document.fullscreenElement) || (mapWrap && mapWrap.classList.contains('fullscreen-map-active'));

    // Si es pantalla completa, sincronizar tamaño antes del fitBounds para calcular dimensiones exactas
    if (isFs && typeof S.map.invalidateSize === 'function') {
      S.map.invalidateSize(false);
    }

    // Autoajustar el mapa con margen perimetral seguro para que ninguna parada quede fuera
    if (allCoords.length > 1 && typeof L !== 'undefined' && L.latLngBounds) {
      const bounds = L.latLngBounds(allCoords);
      if (bounds.isValid()) {
        S.map.fitBounds(bounds, { padding: [50, 50], animate: false });
      }
    }

    // Sincronizar dimensiones del contenedor del mapa
    if (typeof S.map.invalidateSize === 'function') {
      S.map.invalidateSize(false);
    }

    // Esperar sincronización y renderizado de teselas del mapa en el nuevo encuadre
    await new Promise<void>(resolve => {
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      const safetyTimer = setTimeout(finish, isFs ? 1000 : 600);
      if (S.tiles && typeof S.tiles.once === 'function') {
        S.tiles.once('load', () => {
          clearTimeout(safetyTimer);
          setTimeout(finish, isFs ? 250 : 100);
        });
      }
    });

    // c) html2canvas con dimensiones exactas sin distorsión
    const rect = mapElement.getBoundingClientRect();
    const w = Math.round(rect.width) || window.innerWidth || mapElement.offsetWidth;
    const h = Math.round(rect.height) || window.innerHeight || mapElement.offsetHeight;

    let canvas: HTMLCanvasElement;
    if (isFs) {
      // Modo Pantalla Completa: Soporte específico dedicado para capturar contenedor fullscreen sin cortes
      canvas = await html2canvas(mapElement, {
        useCORS: true,
        allowTaint: true,
        width: w,
        height: h,
        x: 0,
        y: 0,
        scrollX: 0,
        scrollY: 0,
        windowWidth: w,
        windowHeight: h,
        scale: 2,
        logging: false,
        ignoreElements: (element: HTMLElement) => (
          element.classList.contains('leaflet-control-container') ||
          element.classList.contains('map-floating-controls') ||
          element.classList.contains('map-ui-overlay') ||
          element.id === 'btnDownloadMapPng' ||
          element.id === 'btnToggleFullscreen' ||
          element.id === 'downloadMapBtn' ||
          element.id === 'btnDownloadMapPngHeader'
        ),
        onclone: (clonedDoc: Document) => {
          if (clonedDoc.documentElement) {
            clonedDoc.documentElement.style.width = `${w}px`;
            clonedDoc.documentElement.style.height = `${h}px`;
            clonedDoc.documentElement.style.overflow = 'hidden';
            clonedDoc.documentElement.style.margin = '0';
            clonedDoc.documentElement.style.padding = '0';
          }
          if (clonedDoc.body) {
            clonedDoc.body.style.width = `${w}px`;
            clonedDoc.body.style.height = `${h}px`;
            clonedDoc.body.style.margin = '0';
            clonedDoc.body.style.padding = '0';
            clonedDoc.body.style.overflow = 'hidden';
            clonedDoc.body.classList.add('capturing-map');
          }
          const cWrap = clonedDoc.getElementById('mapWrap');
          if (cWrap) {
            cWrap.classList.add('capturing-map');
            cWrap.style.setProperty('position', 'fixed', 'important');
            cWrap.style.setProperty('top', '0px', 'important');
            cWrap.style.setProperty('left', '0px', 'important');
            cWrap.style.setProperty('width', `${w}px`, 'important');
            cWrap.style.setProperty('height', `${h}px`, 'important');
            cWrap.style.setProperty('max-width', 'none', 'important');
            cWrap.style.setProperty('max-height', 'none', 'important');
            cWrap.style.setProperty('margin', '0px', 'important');
            cWrap.style.setProperty('padding', '0px', 'important');
            cWrap.style.setProperty('border-radius', '0px', 'important');
            cWrap.style.setProperty('z-index', '999999', 'important');
          }
          const cMap = clonedDoc.getElementById('map');
          if (cMap) {
            cMap.style.setProperty('position', 'absolute', 'important');
            cMap.style.setProperty('top', '0px', 'important');
            cMap.style.setProperty('left', '0px', 'important');
            cMap.style.setProperty('width', `${w}px`, 'important');
            cMap.style.setProperty('height', `${h}px`, 'important');
          }
        }
      });
    } else {
      // Modo Normal (exactamente la implementación original e intacta)
      canvas = await html2canvas(mapElement, {
        useCORS: true,
        allowTaint: true,
        width: w,
        height: h,
        scale: 2,
        logging: false,
        ignoreElements: (element: HTMLElement) => (
          element.classList.contains('leaflet-control-container') ||
          element.classList.contains('map-floating-controls') ||
          element.classList.contains('map-ui-overlay') ||
          element.id === 'btnDownloadMapPng' ||
          element.id === 'btnToggleFullscreen' ||
          element.id === 'downloadMapBtn' ||
          element.id === 'btnDownloadMapPngHeader'
        )
      });
    }

    const imgData = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    const isAll = S.viewMode === 'all' || S.currentRouteIndex === -1;
    const namePrefix = isAll ? 'Todas_Las_Rutas' : `Ruta_${S.currentRouteIndex + 1}`;
    const dateStr = new Date().toISOString().slice(0, 10);
    link.download = `Mapa_${namePrefix}_${dateStr}.png`;
    link.href = imgData;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('¡Captura completa del mapa descargada con éxito sin cortes!', 'success');
  } catch (err) {
    console.error('Error capturando mapa:', err);
    toast('No se pudo generar la imagen del mapa. Intenta nuevamente.', 'error');
  } finally {
    // d) Restaura los controles inmediatamente después de generar la imagen
    if (mapWrap) mapWrap.classList.remove('capturing-map');
    document.body.classList.remove('capturing-map');

    if (prevCenter && prevZoom !== undefined && S.map) {
      S.map.setView(prevCenter, prevZoom, { animate: false });
      if (typeof S.map.invalidateSize === 'function') {
        S.map.invalidateSize(false);
      }
    }
  }
}

if (typeof window !== 'undefined') {
  (window as any).downloadMapAsPng = downloadMapAsPng;
  (window as any).captureMap = downloadMapAsPng;
}
