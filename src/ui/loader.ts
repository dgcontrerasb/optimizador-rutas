/**
 * Loader de Procesos Globales adaptado de Uiverse.io con la temática y colores oficiales de Jamar.
 */

let hideTimer: any = null;
let fadeTimer: any = null;

export function showJamarLoader(title = 'OPTIMIZANDO', subtitle = 'Procesando...'): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }

  const overlay = document.getElementById('jamarProcessLoaderOverlay');
  const titleEl = document.getElementById('jamarLoaderCenterText');
  const subEl = document.getElementById('jamarLoaderSubtext');
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = subtitle;

  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
    // Forzar reflow en el navegador para asegurar renderizado inmediato
    void overlay.offsetHeight;
    overlay.style.opacity = '1';
    overlay.style.visibility = 'visible';
    overlay.style.pointerEvents = 'auto';
  }
}

export function hideJamarLoader(delayMs = 0): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }

  const overlay = document.getElementById('jamarProcessLoaderOverlay');
  if (!overlay) return;

  const performHide = () => {
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    fadeTimer = setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.style.display = 'none';
      overlay.style.visibility = 'hidden';
      fadeTimer = null;
    }, 280);
  };

  if (delayMs > 0) {
    hideTimer = setTimeout(performHide, delayMs);
  } else {
    performHide();
  }
}

/**
 * Ejecuta una operación mostrando la animación de proceso de Jamar durante un tiempo
 * mínimo estético (ej. 1.2s - 1.5s) para que el usuario aprecie el cómputo y la optimización.
 */
export async function withJamarLoader<T>(
  task: () => Promise<T> | T,
  title = 'OPTIMIZANDO',
  subtitle = 'Replaneando rutas y cubicaje vial...',
  minDurationMs = 1500
): Promise<T> {
  showJamarLoader(title, subtitle);

  // Ceder dos frames al navegador para asegurar que el DOM pinte el loader al 100%
  // y que la aceleración GPU inicie la rotación del radar Jamar antes del cómputo JS pesado.
  await new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 80);
      });
    });
  });

  const startTime = Date.now();
  let result: T;
  try {
    result = await task();
  } finally {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, minDurationMs - elapsed);
    if (remaining > 0) {
      await new Promise(r => setTimeout(r, remaining));
    }
    hideJamarLoader();
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).showJamarLoader = showJamarLoader;
  (window as any).hideJamarLoader = hideJamarLoader;
  (window as any).withJamarLoader = withJamarLoader;
}
