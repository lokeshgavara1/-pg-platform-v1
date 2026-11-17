import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { config } from 'dotenv';

/** Recreate the test database from migrations once per `npm test` run. */
export default function setup() {
  config();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set in backend/.env');
  if (url === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL (the test DB is wiped)');
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
  return () => rmSync('./storage-test', { recursive: true, force: true });
}
