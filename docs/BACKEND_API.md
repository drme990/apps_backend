# Centralized Backend — Architecture & API Reference

## Overview

The `apps_backend` is a standalone **Node.js + Express + TypeScript** API server that serves as the single backend for all frontend apps:

| App             | Role                              | Connects to Backend Via           |
| --------------- | --------------------------------- | --------------------------------- |
| **manasik-v2**  | Public storefront (manasik.net)   | Next.js rewrites → `/api/*`       |
| **ghadaq**      | Public storefront (ghadqplus.com) | Next.js rewrites → `/api/*`       |
| **admin_panel** | Admin dashboard                   | Next.js rewrites → `/api/admin/*` |

**Only the backend connects to MongoDB Atlas.** The frontend apps contain zero database logic.

---

## Quick Start

```bash
cd apps_backend

# Install dependencies
npm install

# Copy environment file and fill in values
cp .env.example .env

# Create a super admin user
npm run create-admin

# Start development server (with hot reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

Default port: **5000** (configurable via `PORT` env var).

---

## Project Structure

```
apps_backend/
├── src/
│   ├── app.ts                 # Express app setup, middleware, route mounting
│   ├── server.ts              # Entry point (connects DB, starts server)
│   ├── config/
│   │   └── db.ts              # MongoDB connection (single long-lived connection)
│   ├── middleware/
│   │   ├── auth.ts            # JWT cookie authentication (requireAuth)
│   │   └── error-handler.ts   # Global error handler
│   ├── models/                # Mongoose schemas (8 models)
│   │   ├── Product.ts
│   │   ├── Order.ts
│   │   ├── Coupon.ts
│   │   ├── Country.ts
│   │   ├── Referral.ts
│   │   ├── Appearance.ts
│   │   ├── User.ts
│   │   └── ActivityLog.ts
│   ├── services/              # Business logic (8 services)
│   │   ├── jwt.ts
│   │   ├── logger.ts
│   │   ├── rate-limit.ts
│   │   ├── coupon.ts
│   │   ├── currency.ts
│   │   ├── easykash.ts
│   │   ├── fb-capi.ts
│   │   └── cloudinary.ts
│   └── routes/
│       ├── public/            # Unauthenticated routes (7)
│       │   ├── products.ts
│       │   ├── countries.ts
│       │   ├── coupons.ts
│       │   ├── payment.ts
│       │   ├── currency.ts
│       │   ├── appearance.ts
│       │   └── fb-event.ts
│       └── admin/             # Authenticated routes (12)
│           ├── auth.ts
│           ├── users.ts
│           ├── products.ts
│           ├── orders.ts
│           ├── coupons.ts
│           ├── countries.ts
│           ├── referrals.ts
│           ├── logs.ts
│           ├── upload.ts
│           ├── appearance.ts
│           ├── currency.ts
│           └── stats.ts
├── scripts/
│   └── create-admin.ts       # CLI tool to create super admin user
├── .env.example
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## API Routes

### Public Routes (no authentication required)

| Method | Path                         | Description                                   |
| ------ | ---------------------------- | --------------------------------------------- |
| `GET`  | `/api/products`              | List products (paginated, filterable)         |
| `GET`  | `/api/products/:id`          | Get single product                            |
| `GET`  | `/api/countries`             | List countries (active filter)                |
| `GET`  | `/api/countries/:id`         | Get single country                            |
| `POST` | `/api/coupons/validate`      | Validate a coupon code                        |
| `POST` | `/api/payment/checkout`      | Create order + initiate EasyKash payment      |
| `GET`  | `/api/payment/status`        | Get order status by orderNumber               |
| `POST` | `/api/payment/webhook`       | EasyKash callback (HMAC verified)             |
| `GET`  | `/api/payment/referral-info` | Get referral info for an order                |
| `GET`  | `/api/currency/rates`        | Get exchange rates (with optional conversion) |
| `GET`  | `/api/appearance`            | Get site appearance (works images)            |
| `POST` | `/api/fb-event`              | Relay event to Facebook Conversions API       |
| `GET`  | `/health`                    | Health check                                  |

### Admin Routes (JWT cookie authentication required)

| Method           | Path                                 | Description                         |
| ---------------- | ------------------------------------ | ----------------------------------- |
| `POST`           | `/api/admin/auth/login`              | Login (rate limited: 5/15min)       |
| `POST`           | `/api/admin/auth/logout`             | Logout (clears cookie)              |
| `GET`            | `/api/admin/auth/me`                 | Get current user                    |
| `GET`            | `/api/admin/stats`                   | Dashboard stats (counts)            |
| `GET/POST`       | `/api/admin/products`                | List / Create products              |
| `GET/PUT/DELETE` | `/api/admin/products/:id`            | Get / Update / Delete product       |
| `PUT`            | `/api/admin/products/reorder`        | Bulk reorder products               |
| `POST`           | `/api/admin/products/:id/auto-price` | Auto-calculate currency prices      |
| `GET/POST`       | `/api/admin/orders`                  | List orders (paginated, searchable) |
| `GET/PUT`        | `/api/admin/orders/:id`              | Get / Update order                  |
| `GET/POST`       | `/api/admin/users`                   | List / Create users                 |
| `GET/PUT/DELETE` | `/api/admin/users/:id`               | Get / Update / Delete user          |
| `GET/POST`       | `/api/admin/coupons`                 | List / Create coupons               |
| `GET/PUT/DELETE` | `/api/admin/coupons/:id`             | Get / Update / Delete coupon        |
| `POST`           | `/api/admin/coupons/validate`        | Validate coupon (admin context)     |
| `GET/POST`       | `/api/admin/countries`               | List / Create countries             |
| `GET/PUT/DELETE` | `/api/admin/countries/:id`           | Get / Update / Delete country       |
| `PUT`            | `/api/admin/countries/reorder`       | Bulk reorder countries              |
| `GET/POST`       | `/api/admin/referrals`               | List / Create referrals             |
| `GET/PUT/DELETE` | `/api/admin/referrals/:id`           | Get / Update / Delete referral      |
| `GET`            | `/api/admin/logs`                    | Activity logs (paginated)           |
| `POST`           | `/api/admin/upload/image`            | Upload image to Cloudinary          |
| `DELETE`         | `/api/admin/upload/image`            | Delete image from Cloudinary        |
| `GET`            | `/api/admin/appearance/:project`     | Get appearance for project          |
| `PUT`            | `/api/admin/appearance/:project`     | Update appearance for project       |
| `GET`            | `/api/admin/currency/rates`          | Get exchange rates                  |

---

## Authentication

- **Method**: JWT stored in an httpOnly cookie named `admin-token`
- **Token expiry**: 7 days
- **Cookie settings**:
  - `httpOnly: true` (not accessible to JavaScript)
  - `secure: true` in production
  - `sameSite: 'none'` in production (for cross-origin admin panel)
  - `sameSite: 'lax'` in development
- **Roles**: `admin`, `super_admin`
  - `super_admin` can manage users; `admin` cannot
  - Users have `allowedPages` array controlling dashboard access

---

## Payment Flow (EasyKash)

1. Frontend sends `POST /api/payment/checkout` with product, billing data, currency
2. Backend creates Order (status: `pending`), calls EasyKash Direct Payment API
3. Backend returns `checkoutUrl` → frontend redirects customer
4. Customer completes payment on EasyKash
5. EasyKash sends `POST /api/payment/webhook` → backend verifies HMAC-SHA512, updates order
6. Customer is redirected back to frontend payment status page
7. Frontend polls `GET /api/payment/status?orderNumber=XXX`

**Order number prefixes**: `MNK-` (manasik orders), `GHD-` (ghadaq orders)

---

## Frontend App Configuration

Each frontend app uses **Next.js rewrites** to proxy API calls to this backend:

### manasik-v2 & ghadaq (`next.config.ts`)

```ts
async rewrites() {
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
  return [{ source: '/api/:path*', destination: `${backendUrl}/api/:path*` }];
}
```

### admin_panel (`next.config.ts`)

```ts
async rewrites() {
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
  return [{ source: '/api/:path*', destination: `${backendUrl}/api/admin/:path*` }];
}
```

This means:

- When admin panel fetches `/api/products`, it hits `backend:5000/api/admin/products`
- When manasik fetches `/api/products`, it hits `backend:5000/api/products`

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable               | Description                                   |
| ---------------------- | --------------------------------------------- |
| `PORT`                 | Server port (default: 5000)                   |
| `DATA_BASE_URL`        | MongoDB Atlas connection string               |
| `JWT_SECRET`           | Secret for signing JWT tokens                 |
| `EASYKASH_API_KEY`     | EasyKash API key                              |
| `EASYKASH_HMAC_SECRET` | EasyKash HMAC secret for webhook verification |
| `CLOUDINARY_*`         | Cloudinary credentials for image upload       |
| `API_TOKEN`            | Facebook Conversions API access token         |
| `FB_PIXEL_ID`          | Facebook Pixel ID                             |
| `MANASIK_URL`          | Manasik site URL (for payment redirect)       |
| `GHADAQ_URL`           | Ghadaq site URL (for payment redirect)        |
| `ALLOWED_ORIGINS`      | Comma-separated list of allowed CORS origins  |

---

## Deployment

1. Build: `npm run build` (compiles TypeScript to `dist/`)
2. Start: `npm start` (runs `node dist/server.js`)
3. Ensure all env vars are set
4. The backend must be accessible from all frontend apps
5. Update `BACKEND_URL` in each frontend app's environment
