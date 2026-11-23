// Environment for e2e tests: the compose Postgres (separate `notux_test` database) and fake Google credentials.
// Override E2E_DATABASE_URL to point somewhere else.
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://notux:notux@localhost:5432/notux_test?schema=public';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: E2E_DATABASE_URL,
  FRONTEND_ORIGINS: 'http://localhost:8080',
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
  JWT_SECRET: 'e2e-jwt-secret-that-is-long-enough-1234567890',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  SWAGGER_ENABLED: 'true',
});
