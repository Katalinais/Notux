import { Inject, Injectable } from '@nestjs/common';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { GoogleApiError, GoogleTokenRevokedError, isInvalidGrant } from './google-errors';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_SCOPES = ['openid', 'email', 'profile', DRIVE_FILE_SCOPE];

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** Only present when Google issues one (always with prompt=consent + access_type=offline). */
  refreshToken: string | null;
  scopes: string[];
}

/** Thin wrapper over google-auth-library so the rest of the app (and tests) never touch Google directly. */
@Injectable()
export class GoogleOAuthService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private client(): OAuth2Client {
    const { clientId, clientSecret, redirectUri } = this.config.google;
    return new OAuth2Client({ clientId, clientSecret, redirectUri });
  }

  async createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    const { codeVerifier, codeChallenge } = await this.client().generateCodeVerifierAsync();
    return { codeVerifier, codeChallenge: codeChallenge ?? '' };
  }

  buildAuthUrl(state: string, codeChallenge: string): string {
    return this.client().generateAuthUrl({
      access_type: 'offline',
      // Always ask for consent so Google hands out a refresh token for Drive.
      prompt: 'consent',
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    const client = this.client();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) throw new GoogleApiError(502, 'no_id_token', 'Google did not return an id_token');
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.google.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) throw new GoogleApiError(502, 'no_email', 'Google profile has no email');
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
      refreshToken: tokens.refresh_token ?? null,
      scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
    };
  }

  /** Short-lived access token for Drive. Throws GoogleTokenRevokedError on `invalid_grant`. */
  async getAccessToken(refreshToken: string): Promise<string> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new GoogleApiError(502, 'no_access_token', 'Google did not return an access token');
      return token;
    } catch (err) {
      if (isInvalidGrant(err)) throw new GoogleTokenRevokedError();
      if (err instanceof GoogleApiError) throw err;
      throw new GoogleApiError(502, 'token_refresh_failed', err instanceof Error ? err.message : String(err));
    }
  }
}
