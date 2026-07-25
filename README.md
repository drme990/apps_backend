# backend

Canonical API and business-logic service for Admin Panel, Ghadaq, and Manasik.

## Latest Updates (April 2026)

- Product media migration completed:
  - removed legacy `images` field from model and API contracts
  - standardized `media[]` entries with per-item platform visibility
  - valid platforms: `shared`, `ghadaq`, `manasik`
- Public product APIs now support `platform` query filtering and return only:
  - platform-specific media
  - shared media
- Added migration script:
  - `scripts/migrate-product-media.ts`
  - normalizes old records and removes legacy `images`
- Payment/order reliability improvements:
  - webhook validation and audit hardening
  - partial-payment and payment-link flow maturity

## What This Service Owns

- All admin APIs under `/api/admin/*`.
- All storefront APIs under `/api/*`.
- Authentication namespaces:
  - `/api/auth/admin/*`
  - `/api/auth/ghadaq/*`
  - `/api/auth/manasik/*`
- Checkout/payment state machine and webhook updates.
- Persistence, validation, and operational safeguards.

## Core Domains

- Products and media
- Orders and payments
- Customers and auth
- Coupons and referrals
- Countries and exchange rates
- Appearance and booking dates
- Analytics and activity logs

## Integrations

- MongoDB (Mongoose)
- EasyKash
- Resend
- Cloudflare R2
- Facebook CAPI

## Environment Variables

Create `backend/.env.local`:

```env
DATA_BASE_URL=
JWT_SECRET=

EASYKASH_API_KEY=
EASYKASH_HMAC_SECRET=

R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_URL=

MANASIK_RESEND_API_KEY=
GHADAQ_RESEND_API_KEY=
MANASIK_FROM_EMAIL=
GHADAQ_FROM_EMAIL=

MANASIK_URL=
GHADAQ_URL=
ALLOWED_ORIGINS=
CRON_SECRET=
```

## Scripts

- `npm run dev`
- `npm run build`
- `npm start`
- `npm run lint`

## Migration Scripts

- `npx tsx scripts/migrate-product-media.ts`
- optional URI override:
  - `npx tsx scripts/migrate-product-media.ts --uri=<mongo-uri>`

## Local Run

```bash
cd backend
npm install
npm run dev
```

Default URL: `http://localhost:3000`

## API Docs

Detailed route grouping is documented in `app/api/README.md`.
