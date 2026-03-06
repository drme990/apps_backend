# Referral System Documentation

## Overview

The referral system allows tracking which referral person (agent/marketer) brought a customer to place an order. Each referral person has a unique referral ID that is embedded in checkout URLs. When a customer completes a purchase through a referral link, the order is associated with that referral person, and the customer sees a WhatsApp contact button for the referral person after successful payment.

## Architecture

### Data Flow

```
Admin creates referral → Share URL with ?ref=REFERRAL_ID → Customer checks out
→ Order stores referralId → Payment success shows WhatsApp button to referral person
```

### Components

| Component          | Path                                     | Purpose                                |
| ------------------ | ---------------------------------------- | -------------------------------------- |
| Type               | `types/Referral.ts`                      | TypeScript interface                   |
| Model              | `models/Referral.ts`                     | Mongoose schema & model                |
| API (list/create)  | `app/api/referrals/route.ts`             | GET (paginated) + POST                 |
| API (CRUD)         | `app/api/referrals/[id]/route.ts`        | GET / PUT / DELETE                     |
| API (payment info) | `app/api/payment/referral-info/route.ts` | Get referral phone for payment success |
| Admin Page         | `app/admin/referrals/page.tsx`           | Full CRUD management UI                |
| Payment Status     | `app/payment/status/page.tsx`            | WhatsApp button after success          |
| Checkout           | `app/checkout/page.tsx`                  | Reads `?ref=` param and passes to API  |
| Orders Page        | `app/admin/orders/page.tsx`              | Filter orders by referral              |

---

## Data Model

### Referral (`models/Referral.ts`)

| Field        | Type                      | Description                               |
| ------------ | ------------------------- | ----------------------------------------- |
| `name`       | String (required)         | Name of the referral person               |
| `referralId` | String (required, unique) | Unique identifier used in URLs            |
| `phone`      | String (required)         | WhatsApp phone number (with country code) |
| `createdAt`  | Date                      | Auto-generated timestamp                  |
| `updatedAt`  | Date                      | Auto-generated timestamp                  |

### Order Integration (`models/Order.ts`)

The `Order` model has a `referralId` field (String, optional, indexed) that stores which referral person is associated with the order.

---

## API Endpoints

### `GET /api/referrals`

**Auth:** Required (admin)

Lists all referrals with pagination and search.

**Query Parameters:**

- `page` (default: 1) — Page number
- `limit` (default: 20) — Results per page
- `search` — Search by name, referralId, or phone

**Response:**

```json
{
  "success": true,
  "data": {
    "referrals": [...],
    "pagination": {
      "currentPage": 1,
      "totalPages": 5,
      "totalReferrals": 100,
      "hasNextPage": true,
      "hasPrevPage": false
    }
  }
}
```

### `POST /api/referrals`

**Auth:** Required (admin)

Creates a new referral. Logs activity.

**Body:**

```json
{
  "name": "Ahmed Ali",
  "referralId": "ahmed-ali",
  "phone": "+201234567890"
}
```

### `GET /api/referrals/:id`

**Auth:** Required (admin)

Fetches a single referral by MongoDB `_id`.

### `PUT /api/referrals/:id`

**Auth:** Required (admin)

Updates a referral. Checks for duplicate `referralId`. Logs activity.

### `DELETE /api/referrals/:id`

**Auth:** Required (admin)

Deletes a referral. Logs activity.

### `GET /api/payment/referral-info?order_id=XXX`

**Auth:** None (public)

Fetches the referral person's name and phone for a given Paymob order ID. Used by the payment success page.

**Response (with referral):**

```json
{
  "success": true,
  "data": {
    "name": "Ahmed Ali",
    "phone": "+201234567890"
  }
}
```

**Response (no referral):**

```json
{
  "success": true,
  "data": null
}
```

---

## Usage Flow

### 1. Admin Creates a Referral

Go to **Admin → Referrals** and create a new referral with:

- **Name**: The referral person's display name
- **Referral ID**: A unique short identifier (e.g., `ahmed`, `partner-1`)
- **Phone**: WhatsApp number with country code (e.g., `+201234567890`)

### 2. Generate & Share Referral Link

The referral link format is:

```
https://your-domain.com/checkout?productId=PRODUCT_ID&ref=REFERRAL_ID
```

Example:

```
https://www.manasik.net/checkout?productId=abc123&ref=ahmed
```

The `ref` query parameter is the `referralId` created in step 1.

### 3. Customer Journey

1. Customer opens the referral link
2. The checkout page reads the `ref` parameter from the URL
3. When the customer submits the payment form, the `referralId` is sent to `POST /api/payment/checkout`
4. The order is created with `referralId: "ahmed"` stored in the database
5. Paymob processes the payment and redirects to `/payment/status`

### 4. Post-Payment WhatsApp Button

After successful payment:

1. The payment status page detects `success=true` and the Paymob `order_id`
2. It calls `GET /api/payment/referral-info?order_id=XXX`
3. If the order has a referral person, a green WhatsApp button appears
4. Clicking it opens `https://wa.me/{phone}` — a direct WhatsApp chat with the referral person

### 5. Admin Order Tracking

In **Admin → Orders**:

- A **Referral** dropdown filter lets admins see orders from a specific referral person
- Each order's detail modal shows the associated referral ID (if any)

### 6. Activity Logging

All referral CRUD operations (create, update, delete) are logged in the activity log system under the `referral` resource type. Admins can filter logs by the `Referral` resource in **Admin → Logs**.

---

## Translations

All referral-related UI strings are available in both English and Arabic:

- `admin.referrals.*` — Admin referral management page
- `payment.contactReferral` — WhatsApp button text on payment success (uses `{name}` interpolation)
- `admin.orders.filters.referral` — Orders filter label
- `admin.orders.referral` — Referral label in order detail
- `admin.logs.resources.referral` — Activity log resource filter

---

## File Index

```
types/Referral.ts              — TypeScript interface
models/Referral.ts             — Mongoose model (name, referralId, phone)
models/Order.ts                — Order model (referralId field)
models/ActivityLog.ts          — Activity log (includes 'referral' resource)
app/api/referrals/route.ts     — GET (list) + POST (create)
app/api/referrals/[id]/route.ts — GET + PUT + DELETE
app/api/payment/referral-info/route.ts — Public endpoint for payment page
app/api/payment/checkout/route.ts      — Accepts referralId in body
app/api/orders/route.ts        — Supports referralId filter
app/admin/referrals/page.tsx   — Admin CRUD page
app/admin/orders/page.tsx      — Referral filter + display in modal
app/admin/logs/page.tsx        — Referral resource filter
app/checkout/page.tsx          — Reads ?ref= param
app/payment/status/page.tsx    — WhatsApp button after success
messages/en.json               — English translations
messages/ar.json               — Arabic translations
```
