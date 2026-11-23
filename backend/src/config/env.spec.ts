import { EnvValidationError, validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://notux:notux@localhost:5432/notux',
  FRONTEND_ORIGINS: 'http://localhost:8080, https://usuario.github.io/notux/',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  JWT_SECRET: 'x'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('validateEnv', () => {
  it('parses a valid environment with defaults', () => {
    const config = validateEnv(valid);
    expect(config.port).toBe(3000);
    expect(config.frontendOrigins).toEqual(['http://localhost:8080', 'https://usuario.github.io']);
    expect(config.redirectPrefixes).toEqual(['http://localhost:8080', 'https://usuario.github.io/notux/']);
    expect(config.tokenEncryptionKey).toHaveLength(32);
    expect(config.accessTokenTtlSeconds).toBe(900);
    expect(config.refreshTokenTtlDays).toBe(30);
    expect(config.swaggerEnabled).toBe(true);
  });

  it('reports every problem at once', () => {
    try {
      validateEnv({ ...valid, DATABASE_URL: '', JWT_SECRET: 'short', TOKEN_ENCRYPTION_KEY: 'abc', PORT: 'x' });
      fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const { problems } = err as EnvValidationError;
      expect(problems).toHaveLength(4);
      expect(problems.join('\n')).toMatch(/DATABASE_URL[\s\S]*PORT[\s\S]*JWT_SECRET[\s\S]*TOKEN_ENCRYPTION_KEY/);
    }
  });

  it('rejects non-http origins', () => {
    expect(() => validateEnv({ ...valid, FRONTEND_ORIGINS: 'ftp://x' })).toThrow(/FRONTEND_ORIGINS/);
  });
});
