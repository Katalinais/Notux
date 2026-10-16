const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PBKDF2_ITERATIONS = 100000; // OWASP's current minimum for PBKDF2-SHA256 (check the latest recommendation)

export async function computeHash(text) {
  const data = textEncoder.encode(text);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// Derives a reproducible AES-GCM key from a password and a salt.
// Not exportable: it can't be read or saved, only re-derived.
export async function deriveKeyFromPassword(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = textEncoder.encode(text);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { ciphertext, iv }; // the IV isn't secret, it's stored alongside the ciphertext
}

// If the key or IV don't match, or the ciphertext was tampered with, decrypt()
// rejects the promise instead of returning corrupted data.
export async function decryptText(key, { ciphertext, iv }) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return textDecoder.decode(data);
}
