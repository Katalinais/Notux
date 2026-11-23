import { randomBytes } from 'node:crypto';
import { encrypt } from '../common/crypto';
import { openState, sealState } from './oauth-state';

describe('OAuth state', () => {
  const key = randomBytes(32);
  const state = { redirect: 'http://localhost:8080/', codeVerifier: 'verifier-123', nonce: 'n1', expiresAt: 2_000 };

  it('round-trips and hides the PKCE verifier', () => {
    const sealed = sealState(state, key);
    expect(sealed).not.toContain('verifier-123');
    expect(openState(sealed, key, 1_000)).toEqual(state);
  });

  it('rejects expired, forged or foreign states', () => {
    const sealed = sealState(state, key);
    expect(openState(sealed, key, 2_000)).toBeNull();
    expect(openState(sealed, randomBytes(32), 1_000)).toBeNull();
    expect(openState(undefined, key)).toBeNull();
    expect(openState('garbage', key)).toBeNull();
    // Same key, but sealed for another purpose (no AAD): must not be accepted as a state.
    expect(openState(encrypt(JSON.stringify({ r: 'x', v: 'y', n: 'z', e: 9e15 }), key), key)).toBeNull();
  });
});
