# apps_backend

Canonical API and business-logic service for the full platform.

## What This App Does

- Serves all public storefront APIs for ghadaq and manasik-v2.
- Serves all admin APIs for admin_panel.
- Handles authentication, authorization, validation, and rate-limited operations.
- Owns all data persistence through MongoDB models.
- Integrates external services (EasyKash, email, Cloudinary, Cloudflare R2, Facebook CAPI).

## Architecture Role

- Single source of truth for domain logic.
- Frontend apps should stay thin and call this backend instead of duplicating logic.
- API families:
- /api/admin/\* for back-office operations.
- /api/auth/\* for app-level auth flows.
- /api/payment/\* for checkout, links, status, and webhooks.
- /api/\* public endpoints for products/countries/coupons/appearance/referral.

Request flow:

- admin_panel/ghadaq/manasik-v2 -> apps_backend -> MongoDB + integrations

## Feature Inventory

### Authentication and Authorization

- Admin login/logout/session endpoints.
- Multi-app auth namespaces:
- /api/auth/admin/\*
- /api/auth/ghadaq/\*
- /api/auth/manasik/\*
- Role and permission guards for admin routes.
- App auth guards for user profile and private customer operations.

### Product and Catalog Engine

- Product CRUD, reorder, and auto-pricing support.
- Bilingual content and SEO slug handling.
- Multi-currency pricing and minimum payment structures.
- Reservation-field schema validation and storage.
- Upgrade product logic and metadata handling.
- Best-seller and active/inactive visibility controls.

### Media and Asset Handling

- Image upload/delete through Cloudinary.
- Video upload/delete through Cloudflare R2.
- Product media URLs returned in backend response contract.

### Orders and Checkout

- Checkout order creation pipeline.
- Coupon validation and application.
- Referral attribution.
- Reservation payload persistence.
- Partial-payment support.
- Order lifecycle management and admin-side updates.

### Payments

- EasyKash checkout integration.
- Payment-link creation and tokenized pay-link handling.
- Payment status resolution endpoint.
- Webhook processing and state synchronization.
- Payment-link lifecycle states (unused, opened, used).

### Platform Operations

- Countries CRUD and ordering.
- Exchange-rate endpoints and recalculation trigger.
- Booking blocked-date management.
- Appearance configuration per project.
- Referral CRUD.
- Activity logs and operational audit trails.
- Cron route for price update automation.

## Data Models

Core models include:

- Product
- Order
- User
- Coupon
- Country
- Referral
- ActivityLog
- Appearance
- CronLog

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

## Integrations

- MongoDB (Mongoose)
- EasyKash
- Resend
- Cloudinary
- Cloudflare R2
- Facebook Conversions API

## Environment Variables

Create apps_backend/.env.local:

```env
DATA_BASE_URL=
JWT_SECRET=

EASYKASH_API_KEY=
EASYKASH_HMAC_SECRET=

CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

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

- npm run dev
- npm run build
- npm start
- npm run lint

## Local Development

```bash
cd apps_backend
npm install
npm run dev
```

Default local URL:

- http://localhost:3000

## API Directory Guide

See app/api/README.md for grouped route details and behavior by domain.
