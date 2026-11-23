import { decrypt, encrypt } from '../common/crypto';

// The OAuth `state` parameter is an AES-256-GCM sealed blob: it is tamper-proof, expires,
// and keeps the PKCE verifier secret even though it travels through Google and the browser.
// `nonce` is also set in a short-lived httpOnly cookie, binding the callback to the browser that started it.

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const AAD = 'notux-oauth-state';

export interface OAuthState {
  redirect: string;
  codeVerifier: string;
  nonce: string;
  expiresAt: number;
}

export function sealState(state: OAuthState, key: Buffer): string {
  const payload = { r: state.redirect, v: state.codeVerifier, n: state.nonce, e: state.expiresAt };
  return encrypt(JSON.stringify(payload), key, AAD);
}

/** Returns the state, or null when it is malformed, forged or expired. */
export function openState(sealed: string | undefined, key: Buffer, now = Date.now()): OAuthState | null {
  if (!sealed || sealed.length > 4096) return null;
  try {
    const p = JSON.parse(decrypt(sealed, key, AAD)) as { r?: unknown; v?: unknown; n?: unknown; e?: unknown };
    if (typeof p.r !== 'string' || typeof p.v !== 'string' || typeof p.n !== 'string' || typeof p.e !== 'number') {
      return null;
    }
    if (p.e <= now) return null;
    return { redirect: p.r, codeVerifier: p.v, nonce: p.n, expiresAt: p.e };
  } catch {
    return null;
  }
}
