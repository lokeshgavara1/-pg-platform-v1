# PG Platform

Two mobile-first web apps (owner app, tenant app), a small admin site, and one Node.js backend for managing paying-guest (PG) accommodation in Indian cities, from enquiry to move-out.

> Deviation from the original prompt pack: the apps are React (Vite) web apps instead of Flutter, there is no Docker, and background jobs run in-process instead of BullMQ/Redis. See docs/decisions.md.

## Structure
- backend/: Node.js, TypeScript, Express 5, Prisma, PostgreSQL, zod, Vitest; in-process job scheduler
- web/packages/pg-core: shared TS package (types, API client with token refresh, auth context, money helpers, UI kit, theme)
- web/apps/owner-app, web/apps/tenant-app, web/apps/admin-app: the three React apps
- docs/: product plan, API spec, decisions log, deploy/ops/release notes

## Rules that always apply
- Money is stored as integer paise. Never use floating point for money.
- Every query is scoped to the caller: owners only see their own properties; tenants only see their own data. Enforce this in the backend, never only in the app.
- Never hard-delete tenants, tenancies, invoices, payments or deposit-ledger rows. Use status fields.
- Derive bed status from bookings and tenancies; do not store a separate copy that can drift.
- Write an audit_log row for every change to rent, deposits and KYC status, with actor and time.
- KYC files go in private storage and are opened only through short-lived signed URLs; log each access.
- Never log or store full ID numbers, OTPs or secrets. Secrets live in .env (never committed); keep .env.example up to date.
- Payment status changes only through verified gateway webhooks or an owner marking/confirming money received. A tenant's "I've paid" (direct UPI) is only a report; it never changes an invoice by itself.
- Validate all API input with zod and return one consistent error shape.
- Every rent, invoice, deposit and access-rule change needs automated tests.
- No Docker.

## How to work
- Plan first and show the plan before editing files.
- Keep each change small; one feature per branch; run lint and tests before saying a task is done.
- Ask before adding a dependency or changing the data model.
- At the end, say what changed and how I can verify it myself.

## Commands
- root: npm install, npm run dev (backend + all apps), npm test, npm run lint
- backend: npm run dev -w backend, npm test -w backend, npm run lint -w backend, npm run db:migrate -w backend, npm run db:seed -w backend
- apps: npm run dev -w owner-app | tenant-app | admin-app, npm test -w web/apps/owner-app
