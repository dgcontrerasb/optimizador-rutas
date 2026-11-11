import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { LoginView, SplitCurtainState } from '../components/LoginView';
import {
  clearAuthenticatedSession,
  isSessionAuthenticated
} from '../services/auth';
import { S, toast } from '../state/store';

let loginReactRoot: Root | null = null;
let isTransitioning = false;

function renderLoginCurtain(curtainState: SplitCurtainState): void {
  const loginContainer = document.getElementById('login-root');
  if (!loginContainer) return;

  if (!loginReactRoot) {
    loginReactRoot = createRoot(loginContainer);
  }

  loginReactRoot.render(
    <React.StrictMode>
      <LoginView
        curtainState={curtainState}
        onLoginSuccess={() => {
          animateLoginSplitCurtainOpen();
        }}
      />
    </React.StrictMode>
  );
}

/**
 * Opción 1 (Inicio de Sesión): Apertura de Compuertas "Split Curtain" 50/50
 * Las dos mitades del Login se deslizan hacia los extremos izquierdo y derecho,
 * mientras la Consola de Despacho emerge desde el fondo con un zoom suave.
 */
export function animateLoginSplitCurtainOpen(): void {
  if (isTransitioning) return;
  isTransitioning = true;

  const loginContainer = document.getElementById('login-root');
  const consoleWrapper = document.getElementById('appConsoleWrapper');

  if (loginContainer) {
    loginContainer.className = 'fixed inset-0 z-[9999] overflow-hidden pointer-events-none';
  }

  if (consoleWrapper) {
    consoleWrapper.classList.remove('hidden');
    consoleWrapper.style.transition = 'none';
    consoleWrapper.style.transform = 'scale(0.97)';
    consoleWrapper.style.opacity = '0';

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        consoleWrapper.style.transition =
          'transform 1050ms cubic-bezier(0.16, 1, 0.3, 1), opacity 950ms cubic-bezier(0.16, 1, 0.3, 1)';
        consoleWrapper.style.transform = 'scale(1)';
        consoleWrapper.style.opacity = '1';
      });
    });
  }

  // Abrir las dos compuertas 50/50 del Login
  renderLoginCurtain('opening');

  setTimeout(() => {
    if (loginContainer) {
      loginContainer.className = 'hidden';
    }
    if (consoleWrapper) {
      consoleWrapper.style.transition = '';
      consoleWrapper.style.transform = '';
      consoleWrapper.style.opacity = '';
    }
    if (S.map && typeof S.map.invalidateSize === 'function') {
      S.map.invalidateSize(false);
    }
    isTransitioning = false;
    toast('Acceso autorizado · Consola de Despacho Cendis Siberia', 'success');
  }, 1150);
}

/**
 * Opción 1 (Cierre de Sesión): Cierre de Compuertas "Split Curtain" 50/50
 * Las dos mitades del Login entran desde los bordes izquierdo y derecho hasta
 * cerrarse en el centro mientras la Consola hace un suave zoom-out al fondo.
 */
export function handleLogout(): void {
  if (isTransitioning) return;
  isTransitioning = true;

  clearAuthenticatedSession();

  const loginContainer = document.getElementById('login-root');
  const consoleWrapper = document.getElementById('appConsoleWrapper');

  if (loginContainer) {
    loginContainer.className = 'fixed inset-0 z-[9999] overflow-hidden';
  }

  // 1. Posicionar las compuertas abiertas en los extremos inicialmente
  renderLoginCurtain('opening');

  if (consoleWrapper) {
    consoleWrapper.style.transition =
      'transform 1050ms cubic-bezier(0.16, 1, 0.3, 1), opacity 950ms cubic-bezier(0.16, 1, 0.3, 1)';
    consoleWrapper.style.transform = 'scale(0.97)';
    consoleWrapper.style.opacity = '0.35';
  }

  // 2. Cerrar las compuertas suavemente hacia el centro en el siguiente frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      renderLoginCurtain('closed');
    });
  });

  setTimeout(() => {
    if (consoleWrapper) {
      consoleWrapper.classList.add('hidden');
      consoleWrapper.style.transition = '';
      consoleWrapper.style.transform = '';
      consoleWrapper.style.opacity = '';
    }
    if (loginContainer) {
      loginContainer.className = 'w-full min-h-screen';
    }
    isTransitioning = false;
  }, 1150);
}

export function showConsoleView(): void {
  const loginContainer = document.getElementById('login-root');
  const consoleWrapper = document.getElementById('appConsoleWrapper');

  if (loginContainer) {
    loginContainer.className = 'hidden';
  }
  if (consoleWrapper) {
    consoleWrapper.classList.remove('hidden');
  }

  setTimeout(() => {
    if (S.map && typeof S.map.invalidateSize === 'function') {
      S.map.invalidateSize(false);
    }
  }, 100);
}

export function showLoginView(): void {
  const loginContainer = document.getElementById('login-root');
  const consoleWrapper = document.getElementById('appConsoleWrapper');

  if (consoleWrapper) {
    consoleWrapper.classList.add('hidden');
  }
  if (loginContainer) {
    loginContainer.className = 'w-full min-h-screen';
    renderLoginCurtain('closed');
  }
}

export function initAuthGate(): void {
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      handleLogout();
    };
  }

  // Si un conductor abre el enlace directo (?modo=conductor&ruta=1), entra directo a su Terminal Exclusiva bloqueada
  const params = new URLSearchParams(window.location.search);
  if (params.get('modo') === 'conductor') {
    showConsoleView();
    return;
  }

  if (isSessionAuthenticated()) {
    showConsoleView();
  } else {
    showLoginView();
  }
}

if (typeof window !== 'undefined') {
  (window as any).handleLogout = handleLogout;
}
