import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { ExchangeDto, LoginDto, RefreshTokenDto, SessionDto, TokenPairDto } from './auth.dto';
import { AuthService } from './auth.service';
import { OAUTH_STATE_TTL_MS } from './oauth-state';

const NONCE_COOKIE = 'notux_oauth_nonce';
const COOKIE_PATH = '/auth/google';

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

@ApiTags('auth')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('google')
  @ApiOperation({ summary: 'Start Google login. Open this URL in the browser (top-level navigation).' })
  @ApiQuery({ name: 'redirect', description: 'Frontend URL to come back to; must match FRONTEND_ORIGINS.' })
  @ApiFoundResponse({ description: 'Redirect to the Google consent screen' })
  @ApiBadRequestResponse({ description: '`{ code: "INVALID_REDIRECT" }`' })
  async google(@Query('redirect') redirect: string | undefined, @Res() res: Response): Promise<void> {
    const { url, nonce } = await this.auth.startLogin(redirect);
    // Binds the callback to this browser (login CSRF). Only ever sent to /auth/google*.
    res.cookie(NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.isProduction || this.config.google.redirectUri.startsWith('https:'),
      path: COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_MS,
    });
    res.redirect(302, url);
  }

  @Get('google/callback')
  @ApiOperation({ summary: 'Google redirects here. Ends with a redirect to `<redirect>?login_code=...`.' })
  @ApiFoundResponse({ description: 'Redirect to the frontend with `login_code` or `auth_error`' })
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.auth.handleCallback({ code, state, error, cookieNonce: readCookie(req, NONCE_COOKIE) });
    res.clearCookie(NONCE_COOKIE, { path: COOKIE_PATH });
    if ('redirect' in result) {
      res.redirect(302, result.redirect);
    } else {
      res.status(400).type('text/plain; charset=utf-8').send(result.error);
    }
  }

  @Post('exchange')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Swap the one-time login code for tokens.' })
  @ApiOkResponse({ type: SessionDto })
  @ApiUnauthorizedResponse({ description: '`{ code: "INVALID_LOGIN_CODE" }`' })
  exchange(@Body() body: ExchangeDto): Promise<SessionDto> {
    return this.auth.exchange(body.code);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Tighter than the rest of /auth: guessing passwords should be slow.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in with username and password.' })
  @ApiOkResponse({ type: SessionDto })
  @ApiUnauthorizedResponse({ description: '`{ code: "INVALID_CREDENTIALS" }`' })
  login(@Body() body: LoginDto): Promise<SessionDto> {
    return this.auth.loginWithPassword(body.username, body.password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the refresh token and get a new access token.' })
  @ApiOkResponse({ type: TokenPairDto })
  @ApiUnauthorizedResponse({ description: '`{ code: "INVALID_REFRESH_TOKEN" }`' })
  refresh(@Body() body: RefreshTokenDto): Promise<TokenPairDto> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the session of this refresh token. Idempotent.' })
  @ApiNoContentResponse()
  async logout(@Body() body: RefreshTokenDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }
}
