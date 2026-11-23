import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM envelope: "v1.<iv>.<tag>.<ciphertext>" (base64url parts).
// GCM is authenticated, so tampering or a wrong key makes decryption throw.
const VERSION = 'v1';
const IV_BYTES = 12;

export function encrypt(plaintext: string, key: Buffer, aad = ''): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(envelope: string, key: Buffer, aad = ''): string {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Malformed encrypted value');
  const [, iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('Malformed encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Lookup hash for high-entropy secrets (refresh tokens, login codes). A plain SHA-256 is enough at 256 bits. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
