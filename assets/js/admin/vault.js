// Keeps the GitHub token on this device, encrypted with a passcode only you know.
// AES-GCM with a key derived from the passcode by PBKDF2 (SHA-256, 310,000 rounds).

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(passcode, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(secret, passcode) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(passcode, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret));
  return { v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function unseal(box, passcode) {
  const key = await keyFrom(passcode, unb64(box.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
    return dec.decode(plain);
  } catch {
    throw new Error('That passcode is not right.');
  }
}

const KEY = 'pf-admin-device';
const SESSION = 'pf-admin-session';

export const device = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      return null;
    }
  },
  save(record) {
    localStorage.setItem(KEY, JSON.stringify(record));
  },
  forget() {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(SESSION);
  },
  // The unlocked token lives only for this browser tab.
  session() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION) || 'null');
    } catch {
      return null;
    }
  },
  setSession(record) {
    sessionStorage.setItem(SESSION, JSON.stringify(record));
  },
  endSession() {
    sessionStorage.removeItem(SESSION);
  },
};
