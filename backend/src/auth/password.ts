import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Password hashes: "scrypt$<N>$<r>$<p>$<salt>$<hash>" (base64url salt and hash).
// The parameters travel with the hash, so they can be raised later without
// breaking the passwords already stored.
const PREFIX = 'scrypt';
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

function derive(password: string, salt: Buffer, { N, r, p }: typeof PARAMS): Promise<Buffer> {
  // scrypt needs 128·N·r bytes; the default 32 MB cap is exactly N = 2^15, r = 8.
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r };
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, PARAMS);
  return [PREFIX, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Constant-time check. A malformed stored hash just doesn't match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEY_BYTES) return false;
  const key = await derive(password, salt, { N, r, p });
  return timingSafeEqual(key, expected);
}

/** Usernames are compared lowercase and trimmed: "Ana " and "ana" are the same account. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

// Checked when the username doesn't exist, so a wrong username takes as long
// as a wrong password and response times don't reveal which accounts exist.
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('base64url'));
  return dummyHash;
}
