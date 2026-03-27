# apps_backend

Canonical backend/API for the Ghadaq + Manasik ecosystem.

## Last Updated

- 2026-03-27

## Release Notes

- 2026-03-27: Added auth route support for admin_panel, ghadaq, and manasik apps.
- 2026-03-19: Added payment-link currency conversion and stronger currency validation.
- 2026-03-18: Improved custom pay-link processing and error handling.
- 2026-03-17: Added soft-delete support for products and payment links.
- 2026-03-16: Improved payment status fallback synchronization for delayed webhook scenarios.
- 2026-03-14: Added centralized Zod request validation.
- 2026-03-13: Added structured logging and rate limiting for checkout/coupon endpoints.

## Role in the System

- Owns business logic, DB access, payment flows, auth checks, and admin APIs.
- All app UIs should call this backend (directly or via rewrites/proxy routes).

Request flow:

- storefront/admin -> /api/\* -> apps_backend -> MongoDB + external services

## Stack

- Next.js 16.1.6 (App Router)
- TypeScript
- MongoDB + Mongoose
- EasyKash
- Zod
- Resend
- Cloudinary

## Main Domains

- Authentication and admin authorization.
- Products, countries, coupons, referrals.
- Orders lifecycle and reservation metadata.
- Payments lifecycle (checkout, status, pay links, webhook).
- Analytics and admin stats.
- Activity logging (admin activity only).

## Admin Permission Keys

- products
- orders
- customers
- analytics
- booking
- coupons
- countries
- users
- referrals
- activityLogs
- appearance
- exchange
- payments

## Route Inventory

- Verified route list and usage notes are documented in [docs/ROUTES_INVENTORY.md](../docs/ROUTES_INVENTORY.md).

## Payment Link Lifecycle

- Status values: unused -> opened -> used.
- Tokenized public link handling for order/custom links.
- Webhook finalizes successful payment status.

## Environment

Create apps_backend/.env.local with required values:

```env
DATA_BASE_URL=
JWT_SECRET=
EASYKASH_API_KEY=
EASYKASH_HMAC_SECRET=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
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

- npm run dev
- npm run build
- npm start
- npm run lint

## Run Locally

```bash
cd apps_backend
npm install
npm run dev
```

Default local URL:

- http://localhost:3000

## Notes

- This is the canonical API layer; avoid duplicating DB/business logic in UI apps.
- Keep admin auth/permission checks backend-enforced for every admin route.
