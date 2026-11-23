import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { E2E_DATABASE_URL } from './env-setup';

// Applies the migrations to the e2e database (creating it if needed). Needs `docker compose up -d`.
export default function globalSetup(): void {
  try {
    execSync('npx prisma migrate deploy', {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
      stdio: 'pipe',
    });
  } catch (err) {
    const output = (err as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString() ?? String(err);
    throw new Error(
      `Could not migrate the e2e database (${E2E_DATABASE_URL}). Is Postgres running? (docker compose up -d)\n${output}`,
    );
  }
}
