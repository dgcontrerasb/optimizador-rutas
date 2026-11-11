const AUTH_SALT = 'cendis-siberia-tms-2026-v1';
const EXPECTED_USER_DIGEST = 'd87224df50c14899cbc4464243fb8499ea61b745ff80766793d3f68bc1b72d13';
const EXPECTED_PASS_DIGEST = 'ede0c9f39d45b2b28896a027cddfc5b9283527db4407fa5727c810badde27113';
const SESSION_STORAGE_KEY = 'rutasjamar_auth_session_v1';
const SESSION_TOKEN_VALUE = 'cendis_siberia_verified_session_d87224df';

// Control de fuerza bruta (Rate Limiting)
const LOCKOUT_STORAGE_KEY = 'rutasjamar_auth_lockout_v1';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutos

interface LockoutState {
  failures: number;
  lockedUntil: number;
}

function getLockoutState(): LockoutState {
  try {
    const raw = window.localStorage.getItem(LOCKOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.failures === 'number' && typeof parsed.lockedUntil === 'number') {
        return parsed;
      }
    }
  } catch {}
  return { failures: 0, lockedUntil: 0 };
}

function setLockoutState(state: LockoutState): void {
  try {
    window.localStorage.setItem(LOCKOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function getLoginLockoutStatus(): { locked: boolean; remainingMinutes: number } {
  const state = getLockoutState();
  const now = Date.now();
  if (state.lockedUntil > now) {
    const remaining = Math.max(1, Math.ceil((state.lockedUntil - now) / 60000));
    return { locked: true, remainingMinutes: remaining };
  }
  return { locked: false, remainingMinutes: 0 };
}

export function recordFailedLoginAttempt(): { locked: boolean; remainingMinutes: number } {
  const state = getLockoutState();
  const now = Date.now();
  if (state.lockedUntil > now) {
    const remaining = Math.max(1, Math.ceil((state.lockedUntil - now) / 60000));
    return { locked: true, remainingMinutes: remaining };
  }
  state.failures += 1;
  if (state.failures >= MAX_FAILED_ATTEMPTS) {
    state.lockedUntil = now + LOCKOUT_DURATION_MS;
    setLockoutState(state);
    return { locked: true, remainingMinutes: 15 };
  }
  setLockoutState(state);
  return { locked: false, remainingMinutes: 0 };
}

export function resetFailedLoginAttempts(): void {
  try {
    window.localStorage.removeItem(LOCKOUT_STORAGE_KEY);
  } catch {}
}

/**
 * Implementación pura de SHA-256 (FIPS 180-4) para garantizar funcionamiento
 * tanto en contextos WebCrypto como en iframes/entornos locales restringidos.
 */
function sha256Hex(ascii: string): string {
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i: number, j: number;
  let result = '';

  const words: number[] = [];
  const asciiBitLength = ascii[lengthProperty] * 8;

  let hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;

  const isComposite: Record<number, number> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  ascii += '\x80';
  while ((ascii[lengthProperty] % 64) - 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    if (j >> 8) return '';
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;

  for (j = 0; j < words[lengthProperty]; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash;
    hash = hash.slice(0, 8);

    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15],
        w2 = w[i - 2];

      const a = hash[0],
        e = hash[4];
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);

      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));

      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }

    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }

  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? 0 : '') + b.toString(16);
    }
  }
  return result;
}

function deriveIteratedHash(input: string): string {
  const utf8Str = unescape(encodeURIComponent(input));
  let h = utf8Str;
  for (let i = 0; i < 1000; i++) {
    h = sha256Hex(`${AUTH_SALT}:${h}:${i}`);
  }
  return h;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyCredentialsWithDetails(
  username: string,
  password: string
): { success: boolean; error?: string } {
  const lockout = getLoginLockoutStatus();
  if (lockout.locked) {
    return {
      success: false,
      error: `Demasiados intentos fallidos. Acceso bloqueado temporalmente por ${lockout.remainingMinutes} minuto(s).`
    };
  }

  const normalizedUser = String(username || '').trim().toLowerCase();
  const rawPass = String(password || '').trim();
  if (!normalizedUser || !rawPass) {
    return { success: false, error: 'Por favor ingresa usuario y contraseña.' };
  }

  const userDigest = deriveIteratedHash(normalizedUser);
  const passDigest = deriveIteratedHash(rawPass);

  // Comprobar contra credencial primaria y variables de entorno VITE_AUTH_*
  const envUserHash = (import.meta as any).env?.VITE_AUTH_USER_HASH;
  const envPassHash = (import.meta as any).env?.VITE_AUTH_PASS_HASH;

  const userOk =
    constantTimeEqual(userDigest, EXPECTED_USER_DIGEST) ||
    (envUserHash && constantTimeEqual(userDigest, envUserHash));

  const passOk =
    constantTimeEqual(passDigest, EXPECTED_PASS_DIGEST) ||
    (envPassHash && constantTimeEqual(passDigest, envPassHash));

  if (userOk && passOk) {
    resetFailedLoginAttempts();
    return { success: true };
  }

  const failResult = recordFailedLoginAttempt();
  if (failResult.locked) {
    return {
      success: false,
      error: `Has superado los 5 intentos permitidos. Acceso bloqueado por 15 minutos.`
    };
  }

  const attemptsLeft = MAX_FAILED_ATTEMPTS - getLockoutState().failures;
  return {
    success: false,
    error: `Credenciales inválidas. Te quedan ${attemptsLeft} intento(s) antes del bloqueo temporal.`
  };
}

export function verifyCredentials(username: string, password: string): boolean {
  return verifyCredentialsWithDetails(username, password).success;
}

export function isSessionAuthenticated(): boolean {
  const now = Date.now();
  const checkToken = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.token === SESSION_TOKEN_VALUE && (!parsed.expiresAt || parsed.expiresAt > now)) {
        return true;
      }
    } catch {
      // Compatibilidad hacia atrás si era string plano
      if (raw === SESSION_TOKEN_VALUE) return true;
    }
    return false;
  };

  try {
    if (checkToken(window.localStorage.getItem(SESSION_STORAGE_KEY))) return true;
  } catch {}
  try {
    if (checkToken(window.sessionStorage.getItem(SESSION_STORAGE_KEY))) return true;
  } catch {}
  return false;
}

export function persistAuthenticatedSession(rememberMe: boolean): void {
  const duration = rememberMe ? 7 * 24 * 3600 * 1000 : 12 * 3600 * 1000; // 7 días con 'Recordar' o 12h
  const payload = JSON.stringify({
    token: SESSION_TOKEN_VALUE,
    expiresAt: Date.now() + duration
  });

  try {
    if (rememberMe) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, payload);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {}
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, payload);
  } catch {}
}

export function clearAuthenticatedSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {}
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {}
}

/* =========================================================================
   PROTECCIÓN Y PIN DE ACCESO PARA CONDUCTORES (FASE 3)
   ========================================================================= */

export function getRouteDailyPin(routeId: number, dateKey?: string): string {
  const d = dateKey || new Date().toISOString().slice(0, 10);
  const str = `${AUTH_SALT}:route-${routeId}:${d}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const positive = Math.abs(hash);
  const pinNum = 1000 + (positive % 9000); // Siempre 4 dígitos (1000 - 9999)
  return String(pinNum);
}

export function isDriverSessionAuthenticated(routeId: number, dateKey?: string): boolean {
  const d = dateKey || new Date().toISOString().slice(0, 10);
  const key = `rutasjamar_driver_auth_${routeId}_${d}`;
  try {
    return window.sessionStorage.getItem(key) === 'valid';
  } catch {}
  return false;
}

export function persistDriverSession(routeId: number, dateKey?: string): void {
  const d = dateKey || new Date().toISOString().slice(0, 10);
  const key = `rutasjamar_driver_auth_${routeId}_${d}`;
  try {
    window.sessionStorage.setItem(key, 'valid');
  } catch {}
}

export function verifyDriverPin(
  routeId: number,
  enteredPin: string,
  plate: string = '',
  dateKey?: string
): boolean {
  const cleanPin = String(enteredPin || '').trim();
  if (!cleanPin) return false;

  const validPin = getRouteDailyPin(routeId, dateKey);
  if (cleanPin === validPin) {
    persistDriverSession(routeId, dateKey);
    return true;
  }

  // También se admite como comodín de respaldo los números de la placa asignada
  const plateDigits = plate.replace(/\D/g, '');
  if (plateDigits && cleanPin === plateDigits) {
    persistDriverSession(routeId, dateKey);
    return true;
  }

  return false;
}
