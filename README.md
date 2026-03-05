# apps_backend — Centralized API Server

A standalone **Node.js + Express + TypeScript** backend that serves as the single source of truth for all database operations, payments, authentication, and business logic shared across the **Manasik Foundation** and **Ghadaq Association** platforms.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MongoDB Atlas (manasik)                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
       ┌──────────▼───────────┐
       │    apps_backend      │
       │   Express API :5000  │
       └──┬──────┬────────────┘
          │      │
   ┌──────▼──┐ ┌─▼──────────┐ ┌─────────────┐
   │manasik  │ │  ghadaq/   │ │ admin_panel │
   │  :3000  │ │   :3002    │ │    :3001    │
   └─────────┘ └────────────┘ └─────────────┘
```

All three Next.js apps proxy API calls to this backend via `next.config.ts` rewrites. **No frontend app connects to MongoDB directly.**

---

## Tech Stack

| Concern   | Technology                                   |
| --------- | -------------------------------------------- |
| Runtime   | Node.js 18+                                  |
| Framework | Express 5.1                                  |
| Language  | TypeScript 5                                 |
| Database  | MongoDB Atlas via Mongoose 9                 |
| Auth      | JWT (7d) + bcryptjs + httpOnly cookies       |
| Payment   | EasyKash Direct Payment API v1 (HMAC-SHA512) |
| Email     | Resend                                       |
| Images    | Cloudinary (multer memoryStorage)            |
| Currency  | fawazahmed0 CDN (6 hr in-memory cache)       |
| Facebook  | Conversions API v21 (SHA-256 hashing)        |

---

## Folder Structure

```
src/
  app.ts             — Express app, CORS, route mounts
  server.ts          — Entry point, dotenv load, DB connect
  config/
    db.ts            — MongoDB connection
  middleware/
    auth.ts          — requireAuth (JWT cookie → req.user)
    error-handler.ts — Central error handler
  models/            — 8 Mongoose models
  services/          — jwt, logger, rate-limit, coupon, currency,
                       easykash, fb-capi, cloudinary, email
  routes/
    public/          — Unauthenticated routes (/api/*)
    admin/           — Protected routes (/api/admin/*)
scripts/
  create-admin.ts    — CLI tool to create first admin user
```

---

## API Routes

### Public (`/api/*`)

| Method | Path                    | Description                     |
| ------ | ----------------------- | ------------------------------- |
| GET    | `/api/products`         | List products                   |
| GET    | `/api/products/:id`     | Single product                  |
| GET    | `/api/countries`        | List countries                  |
| GET    | `/api/coupons/validate` | Validate coupon code            |
| POST   | `/api/payment/checkout` | Create order + EasyKash session |
| GET    | `/api/payment/status`   | Order status by `orderNumber`   |
| POST   | `/api/payment/webhook`  | EasyKash payment webhook        |
| GET    | `/api/currency`         | Exchange rates                  |
| GET    | `/api/appearance`       | Homepage appearance config      |
| POST   | `/api/fb-event`         | Browser-side FB event proxy     |

### Admin (`/api/admin/*` — requires `admin-token` cookie)

| Method              | Path                      | Description                  |
| ------------------- | ------------------------- | ---------------------------- |
| POST                | `/api/admin/auth/login`   | Login                        |
| GET                 | `/api/admin/auth/me`      | Current user                 |
| POST                | `/api/admin/auth/logout`  | Logout                       |
| GET/POST            | `/api/admin/products`     | Products CRUD                |
| PUT/DELETE          | `/api/admin/products/:id` |                              |
| GET/PUT             | `/api/admin/orders`       | Orders list + update         |
| GET/POST/PUT/DELETE | `/api/admin/coupons`      | Coupons                      |
| GET/POST/PUT/DELETE | `/api/admin/countries`    | Countries                    |
| GET/POST/PUT/DELETE | `/api/admin/users`        | Admin users                  |
| GET                 | `/api/admin/referrals`    | Referrals                    |
| GET                 | `/api/admin/logs`         | Activity logs                |
| POST                | `/api/admin/upload/image` | Cloudinary image upload      |
| GET/PUT             | `/api/admin/appearance`   | Appearance config            |
| GET                 | `/api/admin/currency`     | Force-refresh currency cache |
| GET                 | `/api/admin/stats`        | Dashboard counts             |

---

## Getting Started

### 1. Install

```bash
cd apps_backend
npm install
```

### 2. Environment variables

Create a `.env` file in `apps_backend/`:

```env
# Server
PORT=5000
NODE_ENV=development

# Database
DATA_BASE_URL=mongodb+srv://user:password@cluster.mongodb.net/manasik

# JWT
JWT_SECRET=a-long-random-secret-change-in-production

# EasyKash
EASYKASH_API_KEY=
EASYKASH_HMAC_SECRET=

# Cloudinary
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Resend (transactional email)
RESEND_API_KEY=
MANASIK_FROM_EMAIL=orders@manasik.net
GHADAQ_FROM_EMAIL=orders@ghadqplus.com

# Facebook Conversions API
API_TOKEN=
FB_PIXEL_ID=
FB_TEST_EVENT_CODE=

# Site URLs (used in EasyKash redirects + emails)
MANASIK_URL=https://www.manasik.net
GHADAQ_URL=https://www.ghadqplus.com

# CORS (comma-separated)
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3002
```

### 3. Create first admin

```bash
npm run create-admin
```

### 4. Run

```bash
npm run dev    # development (tsx watch)
npm run build  # compile TypeScript
npm start      # production (node dist/server.js)
```

---

## Email Notifications

Order confirmation emails are sent automatically when a payment status transitions to **paid**, triggered by:

- EasyKash webhook (`POST /api/payment/webhook`)
- Admin manually marking an order paid via `PUT /api/admin/orders/:id`

Two fully branded HTML templates are used:

- **Manasik** — green gradient (#33ad6c), navy footer
- **Ghadaq** — gold gradient (#ffc001), forest green footer

Emails are bilingual — Arabic RTL when the order locale is `ar`, English otherwise.

> Requires `RESEND_API_KEY` and a verified sending domain configured in Resend.

---

## Deployment

The backend is intended to run as a standalone Node.js process (e.g. on a VPS or a PaaS like Railway, Render, or Fly.io). Point the three Next.js apps at it via their `BACKEND_URL` env variable.

**Production checklist:**

- Set `NODE_ENV=production`
- Use a strong, unique `JWT_SECRET`
- Set `ALLOWED_ORIGINS` to only your live domains
- Use the MongoDB Atlas connection string for `DATA_BASE_URL`
