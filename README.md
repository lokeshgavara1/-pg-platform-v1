# PG Platform

Run a paying-guest (PG) accommodation from first enquiry to move-out: an **owner app**, a **tenant app**, a small **admin site**, and one **Node.js + PostgreSQL backend** that holds every rule.

Built from the two documents in this folder: *PG Platform: Idea, Research and Decisions* and *Claude Code Prompt Pack: PG Platform*. Deviations (React web apps instead of Flutter, no Docker, in-process jobs instead of Redis) are explained in [docs/decisions.md](docs/decisions.md).

## What's inside

| Path | What |
| --- | --- |
| `backend/` | Express 5 + TypeScript + Prisma + PostgreSQL. Auth, beds, tenants, invoices, payments, bookings, KYC, agreements, complaints, notices, move-out, verification, admin, jobs. |
| `web/packages/pg-core` | Shared API client (token refresh), auth, money/date helpers, UI kit and theme. |
| `web/apps/owner-app` | Owner & staff app (port 5173). |
| `web/apps/tenant-app` | Tenant app (port 5174). |
| `web/apps/admin-app` | Pilot-support admin site (port 5175). |
| `docs/` | API, decisions, deploy, ops, security review, release notes, agreement template. |

## Requirements

- Node.js 20+ (tested on 24) and npm
- PostgreSQL 14+ running locally (tested on 18)
- No Docker, no Redis

## First-time setup

```bash
npm install
```

1. Copy `backend/.env.example` to `backend/.env` (already done on this machine) and set your Postgres password in `DATABASE_URL` and `TEST_DATABASE_URL`. Generate the four secrets with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Create the database and load sample data:

```bash
npm run db:deploy -w backend
```

```bash
npm run db:seed -w backend
```

## Run everything

```bash
npm run dev
```

This starts the API on http://localhost:4000 and the apps on
- Owner app: http://localhost:5173
- Tenant app: http://localhost:5174
- Admin site: http://localhost:5175

**Logging in (development):** enter a phone number, then read the 6-digit OTP from the backend console (`[DEV SMS] OTP for …`). Seeded accounts:

| Who | Phone | App |
| --- | --- | --- |
| Owner (Ramesh Kumar) | 9000000002 | Owner |
| Staff (caretaker) | 9000000003 | Owner (complaints only) |
| Tenants | 9000000011, 9000000012, 9000000013 | Tenant |
| Admin | 9000000001 | Admin |

New phone numbers can sign up as an owner (owner app) or a tenant (tenant app). The seeded PG's invite code is **SUNRISE1**.

**Payments in development** use the built-in sandbox gateway: "Pay by UPI" opens a sandbox checkout page; clicking *Pay* sends a signed webhook, and the invoice turns to paid. No real money moves.

## Tests and checks

```bash
npm test
```

```bash
npm run lint
```

- `npm test -w backend`: 120 tests (unit + database). They use a **separate** database (`TEST_DATABASE_URL`) that is wiped and rebuilt on every run. Never point it at real data.
- `npm run test:unit -w backend`: maths and helper tests only; no database needed.

## Useful commands

| Command | Does |
| --- | --- |
| `npm run db:migrate -w backend` | Create a new migration after changing `schema.prisma` (dev) |
| `npm run db:studio -w backend` | Browse the database in Prisma Studio |
| `npm run jobs:run -w backend` | Run the daily jobs once (invoices, reminders, expiries) |
| `npm run backup -w backend` | Back up the database to `backend/backups/` |
| `npm run backup -w backend -- --restore-test` | Back up, then prove the dump restores (into a scratch DB) |
| `npm run build` | Production builds of all apps and the backend |

## Before real use

See [docs/security-review.md](docs/security-review.md) and [docs/deploy.md](docs/deploy.md). In short: plug in a real SMS provider, payment gateway (Razorpay is implemented but untested against live sandbox keys), e-sign provider (the current one is **test-only, not legally valid**), confirm your city's police-verification fields, and serve over HTTPS.
