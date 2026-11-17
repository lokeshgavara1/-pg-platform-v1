# API reference

Base URL: `http://localhost:4000` (dev). JSON in and out. Money is **integer paise**; dates are `YYYY-MM-DD` (India calendar dates).

**Auth:** `Authorization: Bearer <accessToken>` (JWT, 15 min). Refresh with `POST /api/auth/refresh` (refresh tokens rotate; reuse of an old one revokes the session).

**Errors** always look like:

```json
{ "error": { "code": "BAD_REQUEST", "message": "Invalid input", "details": [{ "path": "phone", "message": "…" }] } }
```

Codes: `BAD_REQUEST` 400, `NAME_REQUIRED` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `URL_EXPIRED` 403, `NOT_FOUND` 404 (also used for other people's resources, so existence isn't leaked), `CONFLICT` 409, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429, `INTERNAL` 500.

**Lists** that paginate take `page` (default 1) and `pageSize` (default 20, max 100) and return `{ items, page, pageSize, total, totalPages }`.

## Public

| Method & path | Who | Notes |
| --- | --- | --- |
| `GET /health` | anyone | `{ ok, db }`; 503 if the DB is down |
| `POST /api/auth/request-otp` `{phone}` | anyone | 3/10 min per phone, 20/h per IP |
| `POST /api/auth/verify-otp` `{phone, code, app: owner\|tenant\|admin, name?}` | anyone | New numbers need `name` (owner/tenant apps only). Refuses accounts of the wrong type for the app. |
| `POST /api/auth/refresh` `{refreshToken}` | anyone | |
| `POST /api/auth/logout` `{refreshToken}` | anyone | |
| `GET /api/auth/me` | signed in | |
| `POST /webhooks/payments/:provider` | payment gateway | Raw body, signature verified (`x-fake-signature` / `x-razorpay-signature`), idempotent per event id |
| `GET /fake-gateway/pay/:linkId` | anyone with the link | Sandbox checkout page (fake gateway only) |
| `GET /files/:token`, `PUT /files/:token` | holder of a signed URL | Download / upload. Tokens expire (5 / 10 min) and are logged |

## Any signed-in user

| Method & path | Notes |
| --- | --- |
| `POST /api/files/upload-url` `{purpose, mimeType, sizeBytes}` | Tenants: `KYC_ID`, `KYC_PHOTO`, `COMPLAINT_PHOTO`; owners: `DEDUCTION_PHOTO`. JPEG/PNG/WebP (+PDF for ID), ≤ 5 MB; content is magic-byte checked on upload |
| `GET /api/files/:id/view-url` | Only if the caller may see that file (see security-review.md) |
| `GET /api/notifications`, `POST /api/notifications/read-all` | Own notifications only |

## Owner (`/api/owner`, role OWNER; STAFF where noted)

**Properties, rooms, beds**

| Method & path | Who |
| --- | --- |
| `GET /properties` (paged), `GET /properties/:id` | owner, staff (assigned) |
| `POST /properties`, `PATCH /properties/:id` | owner |
| `POST /properties/:id/deactivate` \| `/activate` \| `/invite-code/rotate` | owner |
| `GET /properties/:id/rooms?includeInactive=` | owner, staff — rooms with beds and **derived** `occupancy` |
| `GET /properties/:id/occupancy` | owner, staff — `{ totalBeds, occupied, reserved, vacant, inactive, occupancyBps }` |
| `POST /properties/:id/rooms` `{name, floor, sharingType, rentPaise}` | owner — creates one bed per sharing slot |
| `PATCH /rooms/:id`, `POST /rooms/:id/deactivate` \| `/activate`, `POST /rooms/:id/beds` | owner |
| `PATCH /beds/:id`, `POST /beds/:id/deactivate` \| `/activate` | owner |
| `GET/POST /properties/:id/staff`, `POST /properties/:id/staff/:userId/deactivate` | owner |
| `GET /cities` | owner, staff — compliance configs |

**Tenants**

| Method & path | Notes |
| --- | --- |
| `GET /tenants?propertyId&filter=active\|dues\|notice\|ended&search&page` | owner, staff; includes `outstandingPaise`, `overduePaise` |
| `POST /tenants` | Add tenant: creates user/profile/tenancy, deposit ledger or deposit invoice, verification record, current invoice |
| `GET /tenancies/:id` | Full detail (invoices, ledger, charges, agreement, verification, move-out) |
| `PATCH /tenancies/:id` `{rentPaise?, depositPaise?}` | Audited |
| `POST /tenancies/:id/move-bed` `{bedId}` | |
| `POST /tenancies/:id/end` `{endDate}` | Prorates the last invoice, voids later unpaid ones |
| `POST /tenancies/:id/charges`, `POST /charges/:id/deactivate` | Recurring extras (audited) |
| `POST /tenancies/:id/deposit` `{amountPaise, reason}` | Deposit received outside an invoice (audited) |
| `POST /tenancies/:id/agreement` | Generate agreement PDF draft |

**Rent**

| Method & path | Notes |
| --- | --- |
| `GET /invoices?propertyId&tenancyId&status=DUE\|PARTIAL\|PAID\|VOID\|OVERDUE\|UNPAID&kind&month=YYYY-MM&page` | |
| `GET /invoices/:id` | lines + payments |
| `POST /invoices/:id/payments` `{amountPaise, method: CASH\|UPI_DIRECT, note?, receivedOn?}` | Owner marks money received (cannot exceed balance; audited) |
| `POST /invoices/:id/lines` `{description, amountPaise}` | Extra charge (+) or discount (−) on an unpaid invoice (audited) |
| `POST /invoices/:id/void` `{reason}` | Only if nothing was paid |
| `POST /invoices/:id/payment-link` | Gateway link to share |
| `GET /payments/:id/receipt.pdf` | |
| `POST /invoices/generate` | Run billing now for own properties (idempotent) |
| `GET /dashboard?propertyId` | Occupancy, collected vs due this month, overdue tenants, ending soon, pending counts |

**Bookings, KYC, complaints, notices, move-out, verification**

| Method & path | Who |
| --- | --- |
| `GET /bookings?propertyId&status=LIVE\|…`, `POST /bookings/:id/confirm` \| `/cancel {reason}` \| `/refund-done` | owner |
| `GET /kyc?status=`, `POST /kyc/:profileId/approve`, `POST /kyc/:profileId/reject {reason}` | owner |
| `GET /complaints?propertyId&status`, `GET /complaints/:id` | owner (own PGs), staff (assigned only) |
| `POST /complaints/:id/updates {message, status?}` | owner, assigned staff |
| `POST /complaints/:id/assign {staffUserId}`, `POST /complaints/:id/close {note}` | owner |
| `GET /notices` (owner, staff), `POST /notices {propertyId, roomId?, title, body}`, `POST /notices/:id/archive` | owner |
| `GET /move-outs?propertyId&status=OPEN\|ALL`, `GET /move-outs/:id` | owner |
| `POST /move-outs/:id/accept` \| `/reject {note}` \| `/inspection {checklist}` \| `/settlement {deductions}` \| `/complete` | owner |
| `GET /verification?propertyId&status`, `PATCH /verification/:id {status, reference?, notes?}` | owner |
| `POST /verification/export {tenancyIds, format: csv\|pdf}` | owner — file download |

## Tenant (`/api/tenant`, role TENANT)

| Method & path | Notes |
| --- | --- |
| `GET /home` | Stay, dues, KYC, agreement, booking |
| `GET/PATCH /profile` | Details for police verification |
| `GET /pg/:inviteCode` | Vacant beds and prices (no occupant data) |
| `POST /bookings {bedId, moveInDate}` | Reserve (hold N hours) + token invoice + payment link |
| `GET /bookings`, `POST /bookings/:id/pay-link`, `POST /bookings/:id/cancel` | |
| `GET /invoices?status=UNPAID\|ALL`, `GET /invoices/:id`, `POST /invoices/:id/pay-link` | Own only |
| `GET /payments`, `GET /payments/:id/receipt.pdf` | Receipt history |
| `GET /kyc`, `POST /kyc/submit {idType, idLast4?, idFileId, photoFileId}` | |
| `GET /agreement`, `POST /agreement/:id/request-otp`, `POST /agreement/:id/sign {otp}` | Dev e-sign: one guess per OTP |
| `GET/POST /complaints`, `GET /complaints/:id` | ≤ 3 photos |
| `GET /notices` | Property-wide + own room |
| `GET/POST /move-out`, `POST /move-out/accept`, `POST /move-out/dispute {comment}` | Respects minimum notice days |

## Admin (`/api/admin`, role ADMIN)

| Method & path | Notes |
| --- | --- |
| `GET /users?phone=` | Search (≥ 3 digits) |
| `GET /users/:id`, `GET /users/:id/audit` | |
| `POST /users/:id/deactivate {reason}`, `POST /users/:id/activate` | Audited; revokes sessions |
| `GET /payments/failed`, `GET /webhooks?status=PROBLEMS\|…` | |
