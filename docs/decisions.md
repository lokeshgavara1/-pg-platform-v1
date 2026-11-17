# Decisions log

Decisions taken while building, especially where the build plan was ambiguous or where this machine differed from the plan. Newest last.

## Platform deviations (2026-11-17)

| Plan said | Built | Why |
| --- | --- | --- |
| Two Flutter apps + `pg_core` Dart package | Three React (Vite) web apps + `pg-core` TS package | Flutter/Android SDK not installed; owner chose React web apps. Mobile-first layout, installable as PWAs; can be wrapped for Play Store (see release.md) or ported to Flutter later — the API is unchanged. |
| BullMQ + Redis jobs | In-process hourly scheduler (`backend/src/jobs`) | No Redis/Docker. Every job is idempotent (unique keys), so restarts and overlaps are safe. Move to a queue only when running more than one backend instance. |
| docker-compose for local dev | Local Node + PostgreSQL; CI uses the runner's preinstalled Postgres | Owner asked for no Docker. |
| Rate limiting (implied Redis) | In-memory fixed window | Fine for one instance; see the note in `lib/rateLimit.ts`. |
| zod 3 | zod 4 | zod <4.6.6 had a published high-severity advisory. |
| react-router 6 | react-router 7 (v6-compatible API) | Moderate advisory in v6. |

Remaining `npm audit` items are in the **Prisma CLI's** dev-time dependency (`deepmerge-ts`), not in runtime code. Fixing needs Prisma 7, a larger migration (driver adapters) — schedule it separately.

## Data-model decisions

- **Money** is integer paise everywhere (DB `Int`, API, UI). Proration uses integer round-half-up (`lib/money.ts`). The UI parses typed rupees into paise at the edge only.
- **Bed status is derived**, never stored: OCCUPIED (live tenancy that has started), RESERVED (future tenancy, token-paid booking, or unexpired reservation), VACANT, INACTIVE (owner switched the bed or room off).
- **Double booking** is prevented three ways: a `SELECT … FOR UPDATE` lock on the bed row inside the transaction, partial unique indexes (`booking_one_live_per_bed`, `tenancy_one_live_per_bed`, `tenancy_one_live_per_tenant`), and tests that fire concurrent requests.
- **No hard deletes** for tenants, tenancies, invoices, payments or ledger rows: status fields (`ENDED`, `VOID`, `INACTIVE`, `DEACTIVATED`). Replaced settlement deductions are marked `INACTIVE`.
- **Billing period** = calendar month. First and last months prorate by day (rent and recurring extras alike). Due date = property's due day, clamped into the billed period.
- **Existing tenants added later** are billed from the current month (`Tenancy.billingFrom`), not from their original join date, so adding someone who joined in 2024 doesn't create two years of invoices.
- **Deposit** is tracked by an append-only ledger (COLLECTED / DEDUCTION / REFUND). "Deposit held" = collected − deductions − refunds. Deposit not received at move-in becomes a DEPOSIT invoice; paying it writes the ledger.
- **Booking token** counts towards the deposit when the owner confirms the booking.
- **Settlement maths**: refund = max(0, held − deductions); anything beyond the deposit is shown as "balance due" (never a negative refund). Ledger DEDUCTION and REFUND rows are written when the owner completes the move-out; every intermediate step writes an audit row. Completion is refused if the ledger changed after the proposal.
- **KYC status lives on the tenant profile** (one person, one KYC), so an approval carries over if the tenant moves to another PG on the platform. Only the last 4 characters of an ID number are accepted.
- **Staff** see and update only complaints assigned to them; they cannot change setup, rent, deposits or KYC.
- **Admins** cannot open tenant documents.

## Provider decisions

All outside services sit behind interfaces in `backend/src/providers/`:

| Interface | Implemented now | Real one to plug in |
| --- | --- | --- |
| `SmsProvider` | Console (dev): prints OTP | MSG91 / Gupshup / Twilio |
| `PaymentProvider` | Fake sandbox gateway with signed webhooks + browser checkout page; Razorpay Payment Links (untested without keys) | Razorpay / Cashfree |
| `KycProvider` | Manual review by owner | DigiLocker / e-KYC vendor |
| `EsignProvider` | Dev OTP signing — **TEST ONLY, NOT LEGALLY VALID** (stamped on PDF and UI) | Aadhaar e-sign via licensed ASP (Leegality, Digio…) |
| `MessageProvider` | In-app notification feed (push); FCM falls back to in-app until configured; WhatsApp & SMS are logged stubs | FCM + WhatsApp Business API |
| `StorageProvider` | Local private folder + HMAC-signed URLs (5 min view / 10 min upload) | S3-compatible bucket in an India region |

## Ambiguities resolved

- "Write ledger entries for every step" (move-out): monetary steps write ledger rows; non-monetary steps (notice, acceptance, inspection, proposal, dispute) write audit rows.
- City compliance fields: placeholder configs for Bengaluru, Pune, Noida, Delhi, Hyderabad marked `"verified": false`. **Confirm with the local police station before relying on them.** Submission to any portal is not automated.
- Reminders: if the server is down for a whole day, that day's reminder is skipped rather than sent late.
- Sign-up: new numbers may self-register as owner (owner app) or tenant (tenant app); staff are created by owners; admins only by seed/DB.
