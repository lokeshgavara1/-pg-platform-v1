# Security review (prompt 4.2)

Reviewed 2026-11-17 against the code in this repo. Endpoints and callers are listed in [api.md](api.md).

## How access is enforced

- Every `/api/owner/*` route is mounted behind `authenticate` + `requireRole('OWNER','STAFF')`; each handler then calls a scope helper in `backend/src/modules/access.ts` (`ownedProperty`, `ownedTenancy`, `ownedInvoice`, `managedPropertyIds`…). Setup, money and KYC routes are `OWNER`-only.
- Every `/api/tenant/*` route is behind `requireRole('TENANT')` and queries are filtered by the caller's own user / tenant profile.
- `requireRole` checks the role **loaded from the database**, not the role claimed in the JWT, so a stale or crafted token cannot escalate. Deactivated users are rejected on every request.
- Out-of-scope resources return **404**, so other owners' IDs cannot be probed.
- File access goes through `canAccessFile` (files/service.ts): owners → KYC of their own tenants/applicants, photos and agreements in their PGs; staff → photos of complaints assigned to them; tenants → own files, own agreement, deduction photos on own settlement; admins → none.

## Automated proof (backend/tests/db)

| Claim | Test |
| --- | --- |
| Owner A cannot read/modify owner B's properties, tenancies, invoices, payments, complaints, bookings, exports, agreements, dashboard | `security-dashboard.test.ts`, `properties.test.ts`, `bookings.test.ts`, `complaints-moveout.test.ts` |
| A tenant cannot read another tenant's invoices, payments, complaints, files, settlement | `security-dashboard.test.ts`, `complaints-moveout.test.ts`, `kyc-files.test.ts`, `invoices-payments.test.ts` |
| Expired, forged, `alg: none` and wrong-secret tokens fail; role escalation via token fails | `auth.test.ts` |
| Signed file URLs expire; upload tokens cannot download; used upload URLs cannot overwrite | `kyc-files.test.ts`, `unit/misc.test.ts` |
| Webhook signature, tamper and replay protection; no client-side "mark paid" | `invoices-payments.test.ts` |
| Mass assignment rejected (`.strict()` schemas) | `properties.test.ts` |
| SQL-ish input treated as data; malformed JSON → clean 400; unknown routes don't leak | `security-dashboard.test.ts` |

## Findings

| Severity | Finding | Status |
| --- | --- | --- |
| High | Brute-force of 6-digit OTPs | **Fixed**: 5 attempts per code, codes expire in 5 min, per-phone and per-IP limits; e-sign OTPs burn after one wrong guess. Tests. |
| High | Double booking under concurrency | **Fixed**: row lock + partial unique indexes. Concurrency tests. |
| High | Duplicate/parallel webhooks double-crediting | **Fixed**: unique `(provider, eventId)` + atomic claim of the payment row. Tests. |
| Medium | Uploaded files could be HTML/script with an image MIME type | **Fixed**: magic-byte check, `nosniff`, `no-store`. Test. |
| Medium | CSV export formula injection (`=HYPERLINK(...)` in a name) | **Fixed**: cells starting with `= + - @` are prefixed. Test. |
| Medium | Refresh-token theft | Mitigated: rotation + reuse detection revokes all sessions. Tokens are kept in `localStorage` in the web apps — acceptable for a pilot; move to an httpOnly cookie or the platform keystore if wrapped natively. |
| Medium | In-memory rate limits reset on restart and don't span instances | Accepted for single-instance pilot; move to Postgres/Redis when scaling. |
| Low | Error messages | 500s return a generic message; details go to the error reporter only. Logs redact phones/OTPs/tokens; the request log records path templates, never query strings. |
| Low | Secrets in git | `.env` is git-ignored; `.env.example` has no values. Check `git log -p -- '*.env*'` before every push. |
| Info | Dev providers | The console SMS provider prints OTPs and the dev e-sign is **not legally valid**. Both must be replaced before real tenants use the app. |

Run the whole suite with `npm test -w backend`.
