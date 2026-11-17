/**
 * Database backup + restore test (no Docker; uses the PostgreSQL client tools).
 *
 *   npm run backup -w backend                 -> writes backups/pg_platform-<timestamp>.dump, keeps the newest 14
 *   npm run backup -w backend -- --restore-test
 *        -> also restores the newest dump into a SEPARATE scratch database
 *           (<dbname>_restore_test), compares row counts with the source, and drops the scratch DB.
 *
 * Needs pg_dump / pg_restore / psql on PATH, or set PG_BIN to their folder
 * (e.g. "C:\Program Files\PostgreSQL\18\bin"). The source database is never modified.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const KEEP = Number(process.env.BACKUP_KEEP ?? 14);
const dir = path.resolve(process.env.BACKUP_DIR ?? './backups');
const bin = (name: string) => {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, exe);
  const winDefault = `C:\\Program Files\\PostgreSQL\\18\\bin\\${exe}`;
  return process.platform === 'win32' && existsSync(winDefault) ? winDefault : exe;
};

function conn(urlStr: string) {
  const u = new URL(urlStr);
  return {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
    args: ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)],
    db: u.pathname.slice(1),
  };
}

const TABLES = ['User', 'Property', 'Room', 'Bed', 'Tenancy', 'Invoice', 'Payment', 'DepositLedger', 'AuditLog'];

function counts(c: ReturnType<typeof conn>, db: string) {
  const sql = TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) FROM "${t}"`).join(' UNION ALL ');
  const out = execFileSync(bin('psql'), [...c.args, '-d', db, '-At', '-F', '=', '-c', sql], { env: c.env }).toString();
  return Object.fromEntries(out.trim().split(/\r?\n/).map((l) => l.split('=')));
}

function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const c = conn(url);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${c.db}-${stamp}.dump`);
  execFileSync(bin('pg_dump'), [...c.args, '-d', c.db, '-Fc', '-f', file], { env: c.env, stdio: 'inherit' });
  console.log(`Backup written: ${file} (${(statSync(file).size / 1024).toFixed(1)} KB)`);

  const dumps = readdirSync(dir).filter((f) => f.startsWith(`${c.db}-`) && f.endsWith('.dump')).sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - KEEP))) {
    rmSync(path.join(dir, old));
    console.log(`Pruned old backup ${old}`);
  }

  if (!process.argv.includes('--restore-test')) return;
  const scratch = `${c.db}_restore_test`;
  if (scratch === c.db) throw new Error('Refusing to restore over the source database');
  console.log(`\nRestore test into scratch database "${scratch}"...`);
  const psql = (sql: string) => execFileSync(bin('psql'), [...c.args, '-d', 'postgres', '-c', sql], { env: c.env, stdio: 'pipe' });
  psql(`DROP DATABASE IF EXISTS "${scratch}"`);
  psql(`CREATE DATABASE "${scratch}"`);
  try {
    execFileSync(bin('pg_restore'), [...c.args, '-d', scratch, '--no-owner', file], { env: c.env, stdio: 'inherit' });
    const a = counts(c, c.db);
    const b = counts(c, scratch);
    let ok = true;
    for (const t of TABLES) {
      const same = a[t] === b[t];
      ok &&= same;
      console.log(`  ${same ? 'OK ' : 'BAD'} ${t.padEnd(14)} source=${a[t]} restored=${b[t]}`);
    }
    console.log(ok ? '\nRestore test PASSED' : '\nRestore test FAILED');
    if (!ok) process.exitCode = 1;
  } finally {
    psql(`DROP DATABASE IF EXISTS "${scratch}"`);
  }
}

main();
