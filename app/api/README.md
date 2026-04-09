# API Directory Guide

This folder contains the Next.js App Router API surface (`route.ts`) for the shared platform backend used by:

- `admin_panel`
- `ghadaq`
- `manasik-v2`

## Latest Updates (April 2026)

- Product APIs now follow the unified `media[]` contract.
- Product retrieval supports platform-aware filtering via `platform` query (`ghadaq`, `manasik`) plus `shared` media.
- Order retrieval supports improved date filtering.
- Payment/webhook handlers were hardened for status normalization, validation, and better auditability.
- Payment-link and custom pay-link routes were expanded and stabilized.

## Security Model

Security wrappers are implemented in `@/lib/auth.ts` and applied per route scope:

- `requireAdminPageAccess('page')`:
  - protects `/api/admin/*`
  - enforces admin JWT session and page-level permissions
- `requireAppAuth(appId)`:
  - protects customer-specific routes (`profile`, `my-orders`)
- Public routes:
  - catalog, selected checkout helpers, and payment callback flows

## Route Groups

### 1) Admin APIs (`/api/admin/*`)

Protected admin operations for:

- auth/session inspection
- users and permissions
- products and product reorder
- orders and bulk status changes
- custom payment links
- coupons, countries, referrals
- appearance and booking settings
- analytics, logs, and exchange operations
- media upload/delete endpoints

### 2) Auth APIs (`/api/auth/*`)

Multi-app authentication namespaces:

- `/api/auth/admin/*`
- `/api/auth/ghadaq/*`
- `/api/auth/manasik/*`

Includes login/register/session checks and password reset flows where applicable.

### 3) Storefront/Public APIs (`/api/*`)

Core consumption endpoints for storefront apps:

- `GET /api/products` and product details
- `GET /api/appearance`
- `GET /api/countries`
- `GET /api/booking/blocked-dates`
- `POST /api/coupons/validate`
- `GET /api/currency/rates`
- `GET /api/orders` (limited/public order checks)
- `GET /api/orders/my-orders` (authenticated)
- `GET|PUT /api/customer/[app]/profile` (authenticated)
- `GET /api/referral/[id]`
- `POST /api/fb-event`

### 4) Payment APIs (`/api/payment/*`)

Checkout and transaction lifecycle:

- `POST /api/payment/checkout`
- `POST /api/payment/create-link`
- `GET /api/payment/pay-link/[token]`
- `GET /api/payment/custom-pay-link/[token]`
- `GET /api/payment/referral-info`
- `GET /api/payment/status`
- `POST /api/payment/webhook`

### 5) Cron APIs (`/api/cron/*`)

Scheduled/internal maintenance:

- `GET /api/cron/update-prices`

## Notes for Contributors

- Keep domain logic in services/models under `backend/lib` and keep route handlers thin.
- Reuse shared validation schemas and response helpers.
- For new admin routes, wire permission checks early and log important mutations.
- For payment/webhook changes, preserve idempotency and audit trails.
