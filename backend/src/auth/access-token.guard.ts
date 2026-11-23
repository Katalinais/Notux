import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export const JWT_ISSUER = 'notux';
export const JWT_AUDIENCE = 'notux-api';

export interface AccessTokenPayload {
  sub: string;
}

type AuthedRequest = Request & { userId?: string };

/** Requires `Authorization: Bearer <accessToken>` and exposes the user id via @CurrentUserId(). */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('Missing access token');
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('No subject');
      req.userId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

export const CurrentUserId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const userId = ctx.switchToHttp().getRequest<AuthedRequest>().userId;
  if (!userId) throw new UnauthorizedException();
  return userId;
});
