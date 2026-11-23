import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiError, ErrorCode } from '../common/api-error';
import { randomToken } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { GoogleOAuthService } from '../google/google-oauth.service';
import type { User } from '@prisma/client';
import { toUserDto, UsersService } from '../users/users.service';
import { JWT_AUDIENCE, JWT_ISSUER } from './access-token.guard';
import type { SessionDto, TokenPairDto } from './auth.dto';
import { LoginCodeService } from './login-code.service';
import { dummyPasswordHash, verifyPassword } from './password';
import { OAUTH_STATE_TTL_MS, openState, sealState } from './oauth-state';
import { isAllowedRedirect, withParams } from './redirect';
import { RefreshTokenService } from './refresh-token.service';

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  /** Nonce from the httpOnly cookie set by startLogin. */
  cookieNonce?: string;
}

/** Either a redirect back to the frontend or, when we can't trust the state, a plain error. */
export type CallbackResult = { redirect: string } | { error: string };

const KNOWN_GOOGLE_ERRORS = new Set(['access_denied', 'invalid_scope', 'temporarily_unavailable', 'server_error']);

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly google: GoogleOAuthService,
    private readonly users: UsersService,
    private readonly loginCodes: LoginCodeService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly jwt: JwtService,
  ) {}

  async startLogin(redirect: string | undefined): Promise<{ url: string; nonce: string }> {
    if (!isAllowedRedirect(redirect, this.config.redirectPrefixes)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_REDIRECT, 'redirect is not an allowed frontend URL');
    }
    const { codeVerifier, codeChallenge } = await this.google.createPkcePair();
    const nonce = randomToken(16);
    const state = sealState(
      { redirect: redirect!, codeVerifier, nonce, expiresAt: Date.now() + OAUTH_STATE_TTL_MS },
      this.config.tokenEncryptionKey,
    );
    return { url: this.google.buildAuthUrl(state, codeChallenge), nonce };
  }

  async handleCallback(params: CallbackParams): Promise<CallbackResult> {
    const state = openState(params.state, this.config.tokenEncryptionKey);
    // Without a valid state we don't know (or trust) where to send the user.
    if (!state || !isAllowedRedirect(state.redirect, this.config.redirectPrefixes)) {
      return { error: 'Invalid or expired login state. Start the login again from Notux.' };
    }
    const fail = (reason: string) => ({ redirect: withParams(state.redirect, { auth_error: reason }) });

    if (!params.cookieNonce || params.cookieNonce !== state.nonce) return fail('invalid_state');
    if (params.error) return fail(KNOWN_GOOGLE_ERRORS.has(params.error) ? params.error : 'server_error');
    if (!params.code) return fail('server_error');

    try {
      const identity = await this.google.exchangeCode(params.code, state.codeVerifier);
      const user = await this.users.upsertFromGoogle(identity);
      const loginCode = await this.loginCodes.create(user.id);
      return { redirect: withParams(state.redirect, { login_code: loginCode }) };
    } catch (err) {
      this.logger.error(`Google callback failed: ${err instanceof Error ? err.message : String(err)}`);
      return fail('server_error');
    }
  }

  async exchange(code: string): Promise<SessionDto> {
    const userId = await this.loginCodes.consume(code);
    const user = await this.users.findById(userId);
    if (!user) throw new ApiError(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_LOGIN_CODE, 'Invalid login code');
    return this.startSession(user);
  }

  async loginWithPassword(username: string, password: string): Promise<SessionDto> {
    const user = await this.users.findByUsername(username);
    // Always run one scrypt, so an unknown username isn't faster to reject.
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user?.passwordHash || !ok) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_CREDENTIALS, 'Invalid username or password');
    }
    return this.startSession(user);
  }

  private async startSession(user: User): Promise<SessionDto> {
    const refreshToken = await this.refreshTokens.issue(user.id);
    return { ...(await this.accessToken(user.id)), refreshToken, user: toUserDto(user) };
  }

  async refresh(token: string): Promise<TokenPairDto> {
    const { userId, refreshToken } = await this.refreshTokens.rotate(token);
    return { ...(await this.accessToken(userId)), refreshToken };
  }

  logout(token: string): Promise<void> {
    return this.refreshTokens.revoke(token);
  }

  private async accessToken(userId: string): Promise<{ accessToken: string; expiresIn: number }> {
    const expiresIn = this.config.accessTokenTtlSeconds;
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { expiresIn, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' },
    );
    return { accessToken, expiresIn };
  }
}
