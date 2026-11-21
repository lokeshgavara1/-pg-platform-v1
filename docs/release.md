# Release preparation

Nothing has been published. The apps are mobile-first web apps (PWAs), so there are two routes to Android users.

## Route A — installable web apps (fastest for the pilot)

1. Deploy as in deploy.md (HTTPS is required for install prompts).
2. Each app already ships `manifest.webmanifest`, a theme colour and a placeholder icon (`public/icon.svg`). Replace the icon with real 192px and 512px PNGs before launch.
3. Tenants open the link in Chrome → "Add to Home screen". Payment links work in any browser even without installing (decision: tenants may not install a second app).

## Route B — Google Play internal testing (Trusted Web Activity)

1. Install Bubblewrap: `npm i -g @bubblewrap/cli`.
2. `bubblewrap init --manifest https://owner.yourdomain.in/manifest.webmanifest` (repeat for the tenant app).
3. Application ids: `in.yourdomain.pgowner` and `in.yourdomain.pgtenant`.
4. Signing: Bubblewrap creates a keystore. **Keep it out of git** (`*.keystore` / `*.jks` are git-ignored), back it up in a password manager, and enrol in Play App Signing.
5. Publish `/.well-known/assetlinks.json` on each app domain with the SHA-256 fingerprint Bubblewrap prints, so the app opens without a browser bar.
6. `bubblewrap build` → upload the `.aab` to Play Console → Testing → Internal testing → add up to 100 testers.

Privacy policy URL placeholder: `https://yourdomain.in/privacy` — write it before submitting.

## Play data-safety form: data we collect

| Data | Who | Why | Shared? | Encrypted in transit | Can be deleted |
| --- | --- | --- | --- | --- | --- |
| Name, phone number | owners, staff, tenants | Account, login (OTP), contact | SMS provider (OTP only) | Yes (HTTPS) | Account deactivation; records kept for legal/accounting |
| Guardian/emergency contact, father's name, permanent address, occupation, workplace | tenants | Optional profile the PG owner can see | PG owner only | Yes | On request |
| Government ID photo/PDF, ID type, last 4 ID digits | tenants | ID on file for the PG (KYC) | No (owner of the PG only) | Yes; private storage + short-lived links | On request after stay ends, subject to law |
| Face photo | tenants | KYC | No | Yes | As above |
| Payment info (amounts, gateway reference) | tenants | Rent collection | Payment gateway (processes the card/UPI) | Yes | Kept for accounting |
| Complaint text and photos | tenants | Maintenance | PG owner/staff | Yes | On request |
| Signed agreement | tenants, owners | Rental agreement | No | Yes | Kept for the agreement term + legal period |
| App activity (audit log of changes) | all | Security, disputes | No | Yes | Kept |

No advertising IDs, no location, no contacts, no analytics SDKs.
