# Claude Code Prompt Pack: PG Platform

Nov 11, 2026 · @GTTECH

Paste the CLAUDE.md first, then give Claude Code one prompt at a time, in order, and review and commit after each one. These follow the phases in the build plan.

## CLAUDE.md: paste this into the project root first

Claude Code reads this file at the start of every session, so the rules below apply to every prompt that follows. Create the folder, run `git init`, save this as `CLAUDE.md`, and edit the stack lines if you choose differently.

```markdown
# PG Platform

Two Android-first Flutter apps (owner app, tenant app) and one Node.js backend for managing paying-guest (PG) accommodation in Indian cities, from enquiry to move-out.

## Structure
- backend/: Node.js, TypeScript, Express, Prisma, PostgreSQL, BullMQ with Redis
- mobile/packages/pg_core: shared Dart package (models, API client, auth, theme)
- mobile/apps/owner_app and mobile/apps/tenant_app: the two Flutter apps
- docs/: product plan, API spec, decisions log

## Rules that always apply
- Money is stored as integer paise. Never use floating point for money.
- Every query is scoped to the caller: owners only see their own properties; tenants only see their own data. Enforce this in the backend, never only in the app.
- Never hard-delete tenants, tenancies, invoices, payments or deposit-ledger rows. Use status fields.
- Derive bed status from bookings and tenancies; do not store a separate copy that can drift.
- Write an audit_log row for every change to rent, deposits and KYC status, with actor and time.
- KYC files go in private storage and are opened only through short-lived signed URLs; log each access.
- Never log or store full ID numbers, OTPs or secrets. Secrets live in .env (never committed); keep .env.example up to date.
- Payment status changes only through verified gateway webhooks or an owner marking cash received.
- Validate all API input with zod and return one consistent error shape.
- Every rent, invoice, deposit and access-rule change needs automated tests.

## How to work
- Plan first and show the plan before editing files.
- Keep each change small; one feature per branch; run lint and tests before saying a task is done.
- Ask before adding a dependency or changing the data model.
- At the end, say what changed and how I can verify it myself.

## Commands (update as the project grows)
- backend: npm run dev, npm test, npm run lint, npx prisma migrate dev
- mobile: flutter analyze, flutter test, flutter run
```

## Phase 1 prompts: foundation (weeks 3 to 4)

Goal: a running backend, a database, phone login, and two app shells that can log in. Do not start features until all five prompts pass their checks.

**1.1 Scaffold the repo**

```text
Read CLAUDE.md. Plan first, then create the monorepo skeleton: backend/ (TypeScript, Express, Prisma, zod, Vitest, ESLint), mobile/packages/pg_core, mobile/apps/owner_app and mobile/apps/tenant_app (Flutter, Android only for now), docs/, .gitignore, .env.example and a README with run commands. Each app shows a placeholder home screen and reads the API base URL from config. Do not add features yet. At the end tell me how to run everything.
```

Check: the backend starts, both apps run on an emulator, lint and tests pass.

**1.2 Database schema**

```text
Write the Prisma schema and first PostgreSQL migration for these entities: User (phone, name, role), Property, Room, Bed, TenantProfile, Booking, Tenancy, Agreement, Invoice, Payment, DepositLedger, Complaint, Notice, VerificationRecord, AuditLog. [Paste the data model table from the build plan here.] Money is integer paise. Add created and updated timestamps, status fields instead of deletes, and indexes for property and tenant lookups. Add a seed script: one owner, one property with 3 rooms and 8 beds, and 3 tenants. Do not build endpoints yet. List any decision where the plan was ambiguous.
```

Check: migrate and seed run on a clean database; you can read the seeded data in a database viewer.

**1.3 Phone-OTP login**

```text
Build phone-OTP login: POST /auth/request-otp and POST /auth/verify-otp, with a JWT access token plus a refresh token, and roles owner, tenant, staff and admin. Use an SMS provider interface with a dev implementation that prints the OTP to the console, so a real provider can be plugged in later. Hash stored OTPs, expire them after 5 minutes, rate-limit requests per phone and per IP, and add requireRole(...) middleware. Write tests for expiry, wrong OTP, rate limiting and role checks.
```

Check: you can log in with a seeded phone number using the console OTP, and a tenant token is rejected on an owner-only route.

**1.4 Flutter core package and login screens**

```text
In mobile/packages/pg_core build an API client (dio) with secure token storage, automatic token refresh, typed error handling and an AuthRepository. In both apps add a login screen (phone, then OTP) and a home screen that shows the logged-in user's name and role. Use Riverpod for state and one shared theme. The owner app must refuse tenant accounts and the tenant app must refuse owner accounts, with a clear message. Add widget tests for the login flow.
```

Check: log in from both apps on an emulator or a real Android phone; log out and back in.

**1.5 CI and deployment preparation**

```text
Add GitHub Actions that run backend lint and tests against a Postgres service, and flutter analyze and flutter test for the mobile packages. Add a Dockerfile and docker-compose for backend, Postgres and Redis for local development. Write docs/deploy.md with the steps to deploy the backend to a small VM in an India region: HTTPS, environment variables, daily database backups and a restore test. Do not deploy anything; prepare and explain.
```

Check: the CI run is green on a pull request; `docker compose up` starts the full backend locally.

## Phase 2 prompts: owner app core (weeks 5 to 8)

Goal: one real PG can run beds, tenants and rent on the owner app. Use a real owner's data for the checks.

**2.1 Properties, rooms and beds API**

```text
Build REST endpoints for properties, rooms and beds: create, list, update and deactivate. An owner can only access their own properties; write tests proving that another owner and a tenant are refused. Derive bed status from bookings and tenancies, add an occupancy summary endpoint per property, and paginate list endpoints. Document every endpoint in docs/api.md.
```

**2.2 Owner screens for setup and occupancy**

```text
In owner_app add: property list with create and edit, room and bed management (adding a room with its sharing type and rent creates its beds), and an occupancy grid that shows each bed as vacant, reserved or occupied. Handle loading, empty and error states and small screens. Use the pg_core API client. Add widget tests for the bed grid.
```

**2.3 Tenants and tenancies**

```text
Backend and owner_app: let an owner add a tenant manually (name, phone, guardian contact, join date, bed, monthly rent, deposit). This creates the user if needed, a TenantProfile and a Tenancy, and marks the bed occupied. Add move-bed and end-tenancy actions. Prevent double-booking a bed with a database constraint and a test. Write audit_log rows for every rent and deposit change. Add a tenant list with search and filters for active, dues and notice period.
```

**2.4 Invoices and rent tracking**

```text
Build the invoice engine: a BullMQ job that runs daily and creates monthly invoices for active tenancies, using the rent due day set per property, proration for partial first and last months, and optional extra charges. Make generation idempotent so rerunning it never creates duplicates. Add endpoints and owner screens to view invoices, mark a payment as received in cash or UPI with a note, and generate a receipt PDF. All amounts are paise. Write thorough unit tests for proration, rounding and idempotency before the screens.
```

**2.5 Dashboard**

```text
Add an owner dashboard: occupancy percentage, collected versus due this month, overdue tenants, tenancies ending soon and open complaints count. Aggregate in SQL on the backend with tests and avoid N+1 queries. The app shows summary cards and a list that opens the tenant's page.
```

Phase gate: an owner adds a real PG, enters current tenants, and tracks one month of rent without using a notebook. If this is not true, fix it before starting the tenant app.

## Phase 3 prompts: tenant app (weeks 9 to 11)

Goal: a tenant can book, onboard, pay and move out without the owner re-typing anything. Put every outside provider behind an interface so you can build and test with a fake first, then switch to the real one.

**3.1 Payments with webhooks**

```text
Integrate a payment gateway behind a PaymentProvider interface, starting with its sandbox [name your gateway]. Create payment links for an invoice. Add a webhook endpoint that verifies the signature and is idempotent. Store one payments row per attempt and update the invoice status automatically. Never mark an invoice paid from a client-side callback. Write tests for duplicate webhooks, bad signatures and partial payments.
```

Check: a sandbox payment turns an invoice to paid within seconds; replaying the webhook changes nothing.

**3.2 Booking and token payment**

```text
Tenant app: let a tenant open a PG through an invite link or code from the owner, see available beds and rent, choose a bed and pay the token amount. A reservation holds the bed for a configurable time (default 24 hours) and expires if unpaid. The owner sees reservations, and can confirm or cancel. Prevent two tenants reserving the same bed using a database constraint, and test it with concurrent requests.
```

**3.3 KYC upload and review**

```text
Tenant app: capture or upload an ID document and a photo, compress before upload, and send through signed upload URLs to private storage. Owner app: a review screen to approve or reject with a reason; the tenant sees the status. Enforce file type and size limits and log every file access. Store file references and, if provided, only the last 4 digits of an ID number. Put identity-provider checks behind a KycProvider interface with a manual-review implementation for now.
```

**3.4 Agreement and e-sign**

```text
Generate the rental agreement PDF from tenancy data using the template in docs/agreement-template.md [add your template first]. Put signing behind an EsignProvider interface. Build a development implementation where the tenant confirms with an OTP, and mark clearly in the code and UI that it is for testing only and not a legally valid signature. Store the signed PDF and show it in both apps.
```

**3.5 Rent payment and reminders**

```text
Tenant app: a dues screen, pay by UPI through the gateway link, and a receipt history. Backend: a reminder scheduler (3 days before the due date, on the due date, and 3 days after) that sends through a MessageProvider interface. Implement push through Firebase first and stub WhatsApp and SMS. Let each owner switch reminders on or off, and do not send between 9 pm and 8 am India time.
```

**3.6 Complaints and notices**

```text
Tenant app: raise a complaint with category, description and up to 3 photos; track its status; read owner notices. Owner app: see complaints by property and status, assign to staff, add updates and close with a note; post notices to a property or a room. Send a push notification on every status change. Write tests for who can see and update each complaint.
```

**3.7 Move-out notice and deposit settlement**

```text
Tenant gives a move-out notice with a date, respecting the property's minimum notice days. The owner accepts, records an inspection checklist, and creates a settlement: deposit minus itemised deductions (each with a reason and optional photo) equals the refund. The tenant sees it and accepts or disputes with a comment. Write ledger entries for every step, release the bed when the tenancy ends, and write tests for settlement math and the dispute flow.
```

Phase gate: one test tenant completes the full journey (book, onboard, pay, complain, move out) with real PG data and sandbox providers.

## Phase 4 prompts: compliance, security and release (weeks 12 to 14)

Goal: safe enough to hand real tenants' documents to the app. Do the security prompt even if you are behind schedule.

**4.1 Verification export**

```text
Add a per-city compliance config (JSON files in backend/config/cities) listing the fields the local police or authority needs for tenant details. [Fill in the fields for your pilot city from your own research first.] Build an owner screen and endpoint that exports verification details for selected tenants as CSV and PDF, tracks status (not started, submitted, acknowledged), and reminds the owner about tenants still pending after a configurable number of days. Do not automate submission to any portal.
```

**4.2 Security review**

```text
Act as a security reviewer for this repo. List every API endpoint and who may call it. Then write automated tests proving: owner A cannot read owner B's properties, tenants, invoices, complaints or files; a tenant cannot read another tenant's data; expired or forged tokens fail; signed file URLs expire. Check for missing input validation, SQL injection, mass assignment, secrets in git history or logs, and error messages that leak details. Report findings by severity and fix the critical and high ones, each with a test.
```

**4.3 Backups and monitoring**

```text
Add structured logging with request IDs and no personal data, an error-reporting hook, a health endpoint, rate limiting on public routes, a database backup script, and a documented restore test in docs/ops.md. Run the restore test against a copy of the staging database and report what happened.
```

**4.4 Admin tools for pilot support**

```text
Create a small React admin site, login restricted to the admin role. Features: search users by phone, view a tenant's audit log, deactivate a user, and list failed payments and webhooks. Read-only by default; every change writes an audit_log row. Keep it minimal.
```

**4.5 Release preparation**

```text
Prepare both apps for Google Play internal testing: application ids, release signing (the keystore must stay out of git), a release build, placeholder icons, a privacy policy URL placeholder, and notes for the Play data-safety form listing every kind of data we collect. Write the steps in docs/release.md. Do not publish anything.
```

Phase gate: all critical and high security findings fixed, a restore test passed, and the internal-testing build installs on three different phones.

## Reusable prompts for any time

Use these between the numbered prompts. Replace the text in square brackets.

**Plan before coding**

```text
I want to add [feature]. Read CLAUDE.md and the relevant code. Do not edit anything yet. Give me a short plan: files to change, data model changes, edge cases, and tests. Ask me questions if anything is unclear.
```

**Review my changes**

```text
Review the current git diff as a careful senior engineer. Look for bugs, missing tests, access-control mistakes, money rounding errors, and anything that breaks the rules in CLAUDE.md. List problems by severity and propose fixes; do not change code until I approve.
```

**Write tests first**

```text
For [function or endpoint], write tests that cover normal cases, edge cases and failure cases, including [specific risks]. Run them and confirm the new tests fail for the right reasons. Then implement until they pass.
```

**Debug an error**

```text
Here is the error and what I did: [paste the full error message and steps]. Find the root cause before changing code, explain it in plain words, then make the smallest fix and add a test that would have caught it.
```

**Check a screen on a phone**

```text
Review [screen] for a first-time user on a small Android phone: loading, empty and error states, long text, slow network, and touch target sizes. List the problems, then fix the ones I approve.
```

**Update the docs**

```text
Update docs/api.md, the README and CLAUDE.md so they match the code as it is now. List what you changed and anything that is unclear.
```

**Habits that make these work**

- Give Claude Code one task per session and start a new session for the next one
- Commit after every working step, so you can undo a bad one
- Read every change to login, access rules, payments and deposits yourself
- When it asks a question, answer it; vague answers produce vague code
