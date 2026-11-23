import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, randomToken, sha256 } from './crypto';

describe('token crypto (AES-256-GCM)', () => {
  const key = randomBytes(32);

  it('round-trips a value', () => {
    const secret = '1//0gRefreshTokenFromGoogle-xyz';
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it('uses a fresh IV every time', () => {
    expect(encrypt('same', key)).not.toBe(encrypt('same', key));
  });

  it('never contains the plaintext', () => {
    expect(encrypt('plain-secret-value', key)).not.toContain('plain-secret-value');
  });

  it('rejects a wrong key', () => {
    const envelope = encrypt('secret', key);
    expect(() => decrypt(envelope, randomBytes(32))).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const [v, iv, tag, ct] = encrypt('secret value', key).split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), key)).toThrow();
  });

  it('binds the additional authenticated data', () => {
    const envelope = encrypt('secret', key, 'purpose-a');
    expect(decrypt(envelope, key, 'purpose-a')).toBe('secret');
    expect(() => decrypt(envelope, key, 'purpose-b')).toThrow();
  });

  it('rejects malformed envelopes', () => {
    expect(() => decrypt('nope', key)).toThrow('Malformed');
    expect(() => decrypt('v2.a.b.c', key)).toThrow('Malformed');
  });

  it('makes URL-safe random tokens and stable hashes', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    expect(sha256(token)).toBe(sha256(token));
    expect(sha256(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});
