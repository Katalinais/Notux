// Environment validation. Runs once at startup and fails fast with every problem listed,
// so a misconfigured deploy never boots half-working.

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  /** Exact origins (scheme://host[:port]) allowed by CORS. */
  frontendOrigins: string[];
  /** Allowed post-login redirect prefixes (the raw FRONTEND_ORIGINS entries, which may include a path). */
  redirectPrefixes: string[];
  google: { clientId: string; clientSecret: string; redirectUri: string };
  jwtSecret: string;
  /** 32-byte key for AES-256-GCM. */
  tokenEncryptionKey: Buffer;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  /** Express "trust proxy" setting (needed behind Render/Railway/Fly so rate limiting sees real IPs). */
  trustProxy: boolean | number | string;
  swaggerEnabled: boolean;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}\nSee backend/.env.example.`);
    this.name = 'EnvValidationError';
  }
}

type Env = Record<string, string | undefined>;

function parseOriginEntry(entry: string): string | null {
  try {
    const url = new URL(entry);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw.trim() === '') return false;
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback" or a CIDR list
}

export function validateEnv(env: Env): AppConfig {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is required`);
    return value ?? '';
  };

  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgresql:// connection string');
  }

  const port = parseInteger(env.PORT, 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be an integer between 1 and 65535');

  const rawOrigins = required('FRONTEND_ORIGINS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const frontendOrigins: string[] = [];
  for (const entry of rawOrigins) {
    const origin = parseOriginEntry(entry);
    if (origin) frontendOrigins.push(origin);
    else problems.push(`FRONTEND_ORIGINS entry "${entry}" is not an http(s) URL`);
  }

  const clientId = required('GOOGLE_CLIENT_ID');
  const clientSecret = required('GOOGLE_CLIENT_SECRET');
  const redirectUri = required('GOOGLE_REDIRECT_URI');
  if (redirectUri && !parseOriginEntry(redirectUri)) problems.push('GOOGLE_REDIRECT_URI must be an http(s) URL');

  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');

  const rawKey = required('TOKEN_ENCRYPTION_KEY');
  const tokenEncryptionKey = Buffer.from(rawKey, 'base64');
  if (rawKey && tokenEncryptionKey.length !== 32) {
    problems.push('TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 (generate with: openssl rand -base64 32)');
  }

  const accessTokenTtlSeconds = parseInteger(env.ACCESS_TOKEN_TTL_SECONDS, 900);
  if (!(accessTokenTtlSeconds > 0)) problems.push('ACCESS_TOKEN_TTL_SECONDS must be a positive integer');
  const refreshTokenTtlDays = parseInteger(env.REFRESH_TOKEN_TTL_DAYS, 30);
  if (!(refreshTokenTtlDays > 0)) problems.push('REFRESH_TOKEN_TTL_DAYS must be a positive integer');

  if (problems.length) throw new EnvValidationError(problems);

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port,
    databaseUrl,
    frontendOrigins: [...new Set(frontendOrigins)],
    redirectPrefixes: rawOrigins,
    google: { clientId, clientSecret, redirectUri },
    jwtSecret,
    tokenEncryptionKey,
    accessTokenTtlSeconds,
    refreshTokenTtlDays,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    swaggerEnabled: parseBoolean(env.SWAGGER_ENABLED, true),
  };
}
