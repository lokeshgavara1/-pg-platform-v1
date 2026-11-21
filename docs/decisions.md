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

## Free login instead of SMS (2026-11-18)

SMS OTP always costs money in India (operator charges + DLT registration). The pilot has no budget, so:

- **Primary login: "Continue with Google"** through Firebase Authentication on the free Spark plan. The browser gets a Firebase ID token; the backend verifies it with Google's public keys using only the project id (`FIREBASE_PROJECT_ID`, via the `jose` library) — no service-account secret. The apps load only `@firebase/app` + `@firebase/auth`, lazily (the umbrella `firebase` package pulls in Firestore/gRPC with open advisories).
- **New Google sign-ups** give a name and mobile number once; that number is stored as `phoneVerified=false`. A Google sign-up may **not** claim a number that already has an account (prevents takeover).
- **Existing accounts** connect Google either from inside the app ("Connect Google account", after an OTP login) or through a **one-time login link** the owner sends from their own WhatsApp (`LoginLink`, hashed, 7 days, single use; a new link cancels older ones).
- **Mobile OTP stays** behind the existing `SmsProvider` interface; switch on a real SMS provider later without touching the apps. In local development the OTP is shown on screen (never on staging/production).

## Free rent payments: direct UPI (2026-11-18)

Payment gateways charge per payment (Razorpay is about 2%), so the pilot uses **direct UPI**, which is free in India:

- Each property can have a **UPI ID + payee name** (`Property.upiId`, `upiPayeeName`); every change is audited (`UPI_ID_CHANGED`) because a swapped ID would divert rent.
- The tenant app builds a standard NPCI `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…` link; on a phone it opens GPay/PhonePe/Paytm/BHIM with the exact amount. On a laptop it shows the UPI ID to pay.
- The tenant taps **I've paid** (optional 12-digit UPI reference / UTR) → `Payment` with status `REPORTED`. **The invoice does not change.** Duplicate references in the same PG are refused; at most 3 open reports per invoice; the tenant can withdraw a report.
- The owner checks their UPI app and **confirms** (full or a smaller received amount) or **rejects** with a reason. Confirm uses the same `applyPaymentToInvoice` path as "mark cash received" (row-locked, single-use claim, audited `PAYMENT_CONFIRMED`).
- Booking tokens use the same flow; a reported token payment extends the reservation hold by 72 hours and blocks expiry until the owner decides.
- When a PG has a UPI ID, the gateway link is hidden unless `PAYMENT_PROVIDER=razorpay`. The sandbox/Razorpay code stays for later.
- Known limit: some UPI apps restrict payment links to personal UPI IDs; owners get the most reliable results with a free business UPI ID (PhonePe Business, Paytm for Business, Google Pay for Business). Tenants can always copy the UPI ID and pay manually.

## Ambiguities resolved

- "Write ledger entries for every step" (move-out): monetary steps write ledger rows; non-monetary steps (notice, acceptance, inspection, proposal, dispute) write audit rows.
- Police verification (city field lists, CSV/PDF export, status tracking, reminders) was built and then **removed on 2026-11-21** at the owner's request: the PG already has its permissions and does not need it. ID upload (KYC) and the optional tenant profile details were kept.
- Reminders: if the server is down for a whole day, that day's reminder is skipped rather than sent late.
- Sign-up: new numbers may self-register as owner (owner app) or tenant (tenant app); staff are created by owners; admins only by seed/DB.

## Brand: PGPAL (2026-11-21)

- Name **PGPAL**, tagline "PG & hostel management, made simple". Logo artwork: `brand/pgpal-logo-original.png`.
- The mark was redrawn as a vector (`brand/pgpal-mark.svg`, ~93% pixel overlap with the artwork) so it stays sharp from favicon to login screen and can switch to cream in dark mode and on green bars. Icons: `brand/icons/` (192, 512, maskable 512, Apple touch 180) and `brand/pgpal-icon.svg`.
- Palette from the logo: forest green `#1F4436`, marigold `#D19442`, cream `#ECE8DD`. Type: Outfit (headings, figures; close to the wordmark) + Figtree (body). Signature detail: the marigold folded corner, used only on hero cards, taken beds, the active menu item and the login panel.
- The artwork shows **®**. In India ® may only be used once the trademark is registered (Trade Marks Act 1999, s.107), so the product UI and PDFs omit it; use ™ until registration.
- Internal identifiers (JWT issuer `pg-platform`, browser storage keys) were deliberately left unchanged so nobody is logged out.

## Production hardening (2026-11-21)

Before the first deploy, every development-only convenience was locked out of servers:
- `SMS_PROVIDER`, `PAYMENT_PROVIDER` and `ESIGN_PROVIDER` gained a `none` value; the dev values (`console`, `fake`, `dev`) are refused with `NODE_ENV=production`. The `ALLOW_DEV_PROVIDERS` override was removed. The server also refuses to start if no login method is configured.
- Production login is Google only. Admins get a one-time login link from `npm run admin:create`; staff get one from their owner (WhatsApp). The apps read `GET /api/auth/config` and show only what the server offers.
- **Security fix:** the sandbox payment webhook was reachable on every server, protected only by a default secret. Webhooks are now accepted only for the configured gateway (`PAYMENT_PROVIDER`), so a server with `none` accepts none.
- Agreements are signed on paper in production; the owner records it (`POST /owner/agreements/:id/mark-signed`, audited).
- The demo seed refuses to run in production. `deploy/otp.sh` was removed.
