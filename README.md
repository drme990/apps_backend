# next-backend — Centralized Serverless API

A **Next.js 16 App Router** serverless backend deployed on **Vercel**. Single source of truth for all database operations, payments, authentication, and business logic shared across the **Manasik Foundation** and **Ghadaq Association** platforms.

## Latest Updates (2026-03-09)

- Storefront checkout flow was simplified to 2 steps: **Billing Information** then **Reservation Details**.
- Reservation data remains optional and is only sent when product `reservationFields` exist.
- Checkout requests remain compatible with themed custom date picker values (ISO `YYYY-MM-DD` for date fields).
- Products without reservation fields continue to proceed directly to payment request creation.
- Product `upgradeFeatures` are optional and can be stored independently of `upgradeTo`.
- Upgrade discount offers in storefronts now render a top-aligned large countdown UI without changing backend checkout contract.

---

## Architecture

```
+-------------------------------------------------------------+
|                    MongoDB Atlas (manasik)                   |
+-----------------+-------------------------------------------+
                  |
       +----------v-----------+
       |    next-backend       |
       |   Next.js API :3000   |
       |   (Vercel Serverless) |
       +--+------+------+-----+
          |      |      |
   +------v--+ +-v------v---+ +-------------+
   |manasik  | |  ghadaq/   | | admin_panel |
   |  :3001  | |   :3002    | |    :3003    |
   +---------+ +------------+ +-------------+
```

All three Next.js apps proxy API calls to this backend via `next.config.ts` rewrites. **No frontend app connects to MongoDB directly.**

---

### Tech Stack

| Concern   | Technology                                   |
| --------- | -------------------------------------------- |
| Runtime   | Node.js 18+ (Vercel Serverless Functions)    |
| Framework | Next.js 16.1.6 (App Router)                  |
| Language  | TypeScript 5                                 |
| Database  | MongoDB Atlas via Mongoose 9                 |
| Auth      | JWT (7d) + bcryptjs + httpOnly cookies       |
| Payment   | EasyKash Direct Payment API v1 (HMAC-SHA512) |
| Email     | Resend (per-brand API keys + HTML templates) |
| Images    | Cloudinary (formData upload)                 |
| Currency  | fawazahmed0 CDN (6hr in-memory cache)        |
| Facebook  | Conversions API v21 (SHA-256 hashing)        |
| Cron      | Vercel Cron (daily price updates)            |

---

### Folder Structure

```
lib/
  db.ts              - MongoDB connection singleton (cached promise pattern)
  auth.ts            - Auth helpers (getAuthUser, requireAuth)
  currency-rounding.ts - Currency-specific rounding config
  models/            - 9 Mongoose models (Product, Order, User,
                       Coupon, Country, Referral, ActivityLog,
                       Appearance, CronLog)
  services/          - jwt, logger, rate-limit, coupon, currency,
                       easykash, fb-capi, cloudinary, email
app/api/
  products/          - Public product routes
  countries/         - Public country routes
  coupons/           - Public coupon validation
  currency/          - Public exchange rates
  appearance/        - Public appearance config
  fb-event/          - FB Conversions API proxy
  payment/           - Checkout, status, webhook, referral-info
  admin/             - Protected admin routes (all CRUD)
  cron/              - Vercel Cron job routes
middleware.ts        - CORS handling for all /api routes
vercel.json          - Cron schedule configuration
```

---

### API Routes

**Public (`/api/*`)**

| Method | Path                         | Description                        |
| ------ | ---------------------------- | ---------------------------------- |
| GET    | `/api/products`              | List products (pagination/filters) |
| GET    | `/api/products/:id`          | Single product                     |
| GET    | `/api/countries`             | List countries                     |
| GET    | `/api/countries/:id`         | Single country                     |
| POST   | `/api/coupons/validate`      | Validate coupon code               |
| POST   | `/api/payment/checkout`      | Create order + EasyKash session    |
| GET    | `/api/payment/status`        | Order status by orderNumber        |
| POST   | `/api/payment/webhook`       | EasyKash payment callback          |
| GET    | `/api/payment/referral-info` | Referral info by order             |
| GET    | `/api/currency/rates`        | Exchange rates                     |
| GET    | `/api/appearance`            | Homepage appearance config         |
| POST   | `/api/fb-event`              | Browser-side FB event proxy        |

**Admin (`/api/admin/*` - requires `admin-token` cookie)**

| Method         | Path                                 | Description             |
| -------------- | ------------------------------------ | ----------------------- |
| POST           | `/api/admin/auth/login`              | Login (rate-limited)    |
| GET            | `/api/admin/auth/me`                 | Current user            |
| POST           | `/api/admin/auth/logout`             | Logout                  |
| GET/POST       | `/api/admin/products`                | Products list + create  |
| GET/PUT/DELETE | `/api/admin/products/:id`            | Product CRUD            |
| PUT            | `/api/admin/products/reorder`        | Bulk reorder            |
| POST           | `/api/admin/products/:id/auto-price` | Auto-price conversion   |
| GET            | `/api/admin/orders`                  | Orders list             |
| GET/PUT        | `/api/admin/orders/:id`              | Order detail + update   |
| GET/POST       | `/api/admin/coupons`                 | Coupons list + create   |
| POST           | `/api/admin/coupons/validate`        | Admin coupon validation |
| GET/PUT/DELETE | `/api/admin/coupons/:id`             | Coupon CRUD             |
| GET/POST       | `/api/admin/countries`               | Countries list + create |
| PUT            | `/api/admin/countries/reorder`       | Bulk reorder            |
| GET/PUT/DELETE | `/api/admin/countries/:id`           | Country CRUD            |
| GET/POST       | `/api/admin/users`                   | Users list + create     |
| GET/PUT/DELETE | `/api/admin/users/:id`               | User CRUD               |
| GET/POST       | `/api/admin/referrals`               | Referrals list + create |
| GET/PUT/DELETE | `/api/admin/referrals/:id`           | Referral CRUD           |
| GET            | `/api/admin/logs`                    | Activity logs           |
| POST/DELETE    | `/api/admin/upload/image`            | Cloudinary image mgmt   |
| GET/PUT        | `/api/admin/appearance/:project`     | Appearance config       |
| GET            | `/api/admin/currency/rates`          | Admin exchange rates    |
| GET            | `/api/admin/stats`                   | Dashboard counts        |
| GET            | `/api/admin/exchange/logs`           | Cron execution logs     |
| POST           | `/api/admin/exchange/update-prices`  | Manual price update     |

**Cron (`/api/cron/*` - requires `CRON_SECRET`)**

| Method | Path                      | Schedule       | Description                                   |
| ------ | ------------------------- | -------------- | --------------------------------------------- |
| GET    | `/api/cron/update-prices` | Daily 3:00 UTC | Auto-update product prices via exchange rates |

---

### Getting Started

**1. Install**

```bash
cd next-backend
npm install
```

**2. Environment variables** - Create `.env.local`:

```env
DATA_BASE_URL=mongodb+srv://user:password@cluster.mongodb.net/manasik
JWT_SECRET=a-long-random-secret-change-in-production
EASYKASH_API_KEY=
EASYKASH_HMAC_SECRET=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
MANASIK_RESEND_API_KEY=
GHADAQ_RESEND_API_KEY=
MANASIK_FROM_EMAIL=orders@manasik.net
GHADAQ_FROM_EMAIL=orders@ghadqplus.com
API_TOKEN=
FB_PIXEL_ID=
FB_TEST_EVENT_CODE=
MANASIK_URL=https://www.manasik.net
GHADAQ_URL=https://www.ghadaqplus.com
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002,http://localhost:3003
CRON_SECRET=a-random-secret-for-cron-auth
```

**3. Run**

```bash
npm run dev    # http://localhost:3000
npm run build  # production build
npm start      # production server
```

---

### Vercel Deployment

1. Push `next-backend/` to a Git repo
2. Import in Vercel, set Root Directory to `next-backend`
3. Add all env vars in Vercel dashboard
4. The cron job (`vercel.json`) runs daily at 3:00 AM UTC
5. Set `BACKEND_URL` in each frontend app to the deployed URL

### Exchange Rate Updates

- **Automatic**: Vercel Cron runs daily at 3:00 AM UTC, updating all non-manual product prices based on current exchange rates
- **Manual**: Admins can trigger immediate updates from the Exchange Rates page in the admin panel
- **Manual prices preserved**: Any price marked as `isManual: true` is never overwritten by automatic updates
- **Source tracking**: Each update is logged with `source: 'cron'` or `source: 'manual'` in the CronLog collection, visible in the admin Exchange Rates page

### Currency-Specific Rounding

Auto-calculated prices are rounded per currency using rules defined in `lib/currency-rounding.ts`:

| Rule           | Currencies              | Example     |
| -------------- | ----------------------- | ----------- |
| Nearest 10     | EGP                     | 4→10, 11→20 |
| Nearest 5      | SAR, QAR, USD, EUR, TRY | 2→5, 6→10   |
| Ceil (default) | All others              | 4.1→5       |

To add a new currency, add a line to `CURRENCY_ROUNDING` in `lib/currency-rounding.ts`.

### Email

Order confirmation emails sent automatically when payment status becomes **paid**. Each brand uses its own Resend API key (`MANASIK_RESEND_API_KEY` / `GHADAQ_RESEND_API_KEY`). Two branded HTML templates (Manasik green, Ghadaq gold). Bilingual — Arabic RTL when order locale is `ar`.
