const AUTH_SALT = 'cendis-siberia-tms-2026-v1';
const EXPECTED_USER_DIGEST = 'd87224df50c14899cbc4464243fb8499ea61b745ff80766793d3f68bc1b72d13';
const EXPECTED_PASS_DIGEST = 'ede0c9f39d45b2b28896a027cddfc5b9283527db4407fa5727c810badde27113';
const SESSION_STORAGE_KEY = 'rutasjamar_auth_session_v1';
const SESSION_TOKEN_VALUE = 'cendis_siberia_verified_session_d87224df';

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
      const i2 = i + j;
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

export function verifyCredentials(username: string, password: string): boolean {
  const normalizedUser = String(username || '').trim().toLowerCase();
  const rawPass = String(password || '').trim();
  if (!normalizedUser || !rawPass) return false;

  const userDigest = deriveIteratedHash(normalizedUser);
  const passDigest = deriveIteratedHash(rawPass);

  const userOk = constantTimeEqual(userDigest, EXPECTED_USER_DIGEST);
  const passOk = constantTimeEqual(passDigest, EXPECTED_PASS_DIGEST);
  return userOk && passOk;
}

export function isSessionAuthenticated(): boolean {
  try {
    const local = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (local === SESSION_TOKEN_VALUE) return true;
  } catch {}
  try {
    const session = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (session === SESSION_TOKEN_VALUE) return true;
  } catch {}
  return false;
}

export function persistAuthenticatedSession(rememberMe: boolean): void {
  try {
    if (rememberMe) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, SESSION_TOKEN_VALUE);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {}
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, SESSION_TOKEN_VALUE);
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
