# Operations

## Logging

- One JSON line per request: `requestId`, method, **path template**, status, ms, userId. Never query strings, bodies, phones, names, ID numbers, OTPs or tokens (`lib/logger.ts` also redacts phone-like strings and sensitive keys as a safety net).
- Every response carries `x-request-id`; send it with bug reports so the matching log line can be found. Clients may pass their own `x-request-id`.
- Errors go through `reportError` (`lib/logger.ts`). To use Sentry or similar, call `setErrorReporter(...)` once at startup.

## Health

`GET /health` → `200 {"ok":true,"db":"up"}` or `503`. Point an uptime monitor (UptimeRobot, Better Stack) at it every minute.

## Rate limits (per backend instance)

| Route | Limit |
| --- | --- |
| OTP request | 3 / 10 min per phone, 20 / hour per IP |
| OTP verify | 30 / 10 min per IP, 5 wrong attempts per code |
| Public routes (`/api/auth`, `/files`, `/fake-gateway`) | 300 / min per IP |
| Webhooks | 600 / min per IP |

## Background jobs

Run hourly inside the backend (`JOBS_ENABLED=true`): expire unpaid reservations (also every 5 min), generate invoices, rent reminders (−3/0/+3 days, never 9 pm–8 am IST). All idempotent. Run once by hand with `npm run jobs:run -w backend`.

## Backups and restore test

```bash
npm run backup -w backend
```

writes `backend/backups/<db>-<timestamp>.dump` (custom format) and keeps the newest 14 (`BACKUP_KEEP`).

```bash
npm run backup -w backend -- --restore-test
```

also restores the newest dump into a **separate scratch database** `<db>_restore_test`, compares row counts for the key tables, prints PASSED/FAILED, and drops the scratch database. The source database is never touched.

### Restore test result (2026-11-17, local dev database standing in for staging)

```
Backup written: backend/backups/pg_platform-2026-11-17T07-35-38-139Z.dump (82.1 KB)
Restore test into scratch database "pg_platform_restore_test"...
  OK  User           source=6 restored=6
  OK  Property       source=1 restored=1
  OK  Room           source=3 restored=3
  OK  Bed            source=8 restored=8
  OK  Tenancy        source=3 restored=3
  OK  Invoice        source=3 restored=3
  OK  Payment        source=0 restored=0
  OK  DepositLedger  source=3 restored=3
  OK  AuditLog       source=6 restored=6
Restore test PASSED
```

No staging server exists yet; repeat this against staging once it does.

### Real restore (disaster recovery)

1. Stop the backend: `sudo systemctl stop pg-backend`.
2. Create an empty database and restore: `createdb pg_platform_new && pg_restore -d pg_platform_new --no-owner <file>.dump`.
3. Point `DATABASE_URL` at it (or rename databases), run `npm run db:deploy -w backend`, start the backend, check `/health`, log in and spot-check a tenant's invoices.
4. Restore `STORAGE_DIR` from its own backup so KYC files and PDFs open again.
