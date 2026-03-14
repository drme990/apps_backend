# Endpoint Payload Examples

Last updated: 2026-03-14

This document provides concrete request/response samples grouped by route class.

## 1) Public Checkout & Payment Routes

### POST /api/payment/checkout

Request:

```json
{
  "productId": "67e2b9c1f8c2a4d0b8a11234",
  "quantity": 2,
  "currency": "SAR",
  "billingData": {
    "fullName": "Ahmed Ali",
    "email": "ahmed@example.com",
    "phone": "+966500000000",
    "country": "SA"
  },
  "locale": "ar",
  "couponCode": "RAMADAN10",
  "referralId": "REF001",
  "sizeIndex": 0,
  "paymentOption": "full",
  "termsAgreed": true,
  "reservationData": [
    {
      "key": "sacrificeFor",
      "value": "محمد احمد\nأحمد علي"
    },
    {
      "key": "executionDate",
      "value": "2026-03-20"
    }
  ],
  "source": "manasik"
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "order": {
      "_id": "67e2d5f4f8c2a4d0b8a19876",
      "orderNumber": "MNK-100132",
      "totalAmount": 900,
      "fullAmount": 900,
      "remainingAmount": 0,
      "isPartialPayment": false,
      "currency": "SAR",
      "status": "pending"
    },
    "checkoutUrl": "https://back.easykash.net/...",
    "message": "Order created successfully"
  }
}
```

Validation failure response:

```json
{
  "success": false,
  "error": "Request validation failed",
  "details": "billingData.email: Invalid email"
}
```

### POST /api/payment/webhook

Request:

```json
{
  "ProductCode": "EK-PROD-001",
  "PaymentMethod": "Card",
  "ProductType": "DirectPay",
  "Amount": "900",
  "BuyerEmail": "ahmed@example.com",
  "BuyerMobile": "+966500000000",
  "BuyerName": "Ahmed Ali",
  "Timestamp": "1710412800",
  "status": "PAID",
  "voucher": "",
  "easykashRef": "EKREF123456",
  "VoucherData": "",
  "customerReference": "67e2d5f4f8c2a4d0b8a19876",
  "signatureHash": "<sha512_hmac_hex>"
}
```

Success response:

```json
{
  "success": true
}
```

Duplicate callback response:

```json
{
  "success": true,
  "duplicate": true
}
```

### POST /api/coupons/validate

Request:

```json
{
  "code": "RAMADAN10",
  "orderAmount": 900,
  "currency": "SAR",
  "productId": "67e2b9c1f8c2a4d0b8a11234"
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "code": "RAMADAN10",
    "type": "percentage",
    "value": 10,
    "discountAmount": 90,
    "description": {
      "ar": "خصم رمضان",
      "en": "Ramadan discount"
    }
  }
}
```

## 2) Public Tracking Route

### POST /api/fb-event

Request:

```json
{
  "event_name": "InitiateCheckout",
  "event_id": "ev_123",
  "event_source_url": "https://www.manasik.net/checkout",
  "user_data": {
    "em": "ahmed@example.com"
  },
  "custom_data": {
    "currency": "SAR",
    "value": 900
  }
}
```

Success response:

```json
{
  "success": true
}
```

## 3) Admin Routes

### POST /api/admin/auth/login

Request:

```json
{
  "email": "admin@example.com",
  "password": "StrongPassword123"
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "67d11111f8c2a4d0b8a1abcd",
      "name": "Admin",
      "email": "admin@example.com",
      "role": "super_admin",
      "allowedPages": []
    }
  }
}
```

### PUT /api/admin/orders/:id

Request:

```json
{
  "status": "completed"
}
```

Success response:

```json
{
  "success": true,
  "data": {
    "_id": "67e2d5f4f8c2a4d0b8a19876",
    "orderNumber": "MNK-100132",
    "status": "completed"
  }
}
```

### PUT /api/admin/orders/bulk-status

Request:

```json
{
  "orderIds": [
    "67e2d5f4f8c2a4d0b8a19876",
    "67e2d5f4f8c2a4d0b8a19877"
  ],
  "status": "cancelled"
}
```

### PUT /api/admin/products/reorder

Request:

```json
{
  "orderedIds": [
    "67e2b9c1f8c2a4d0b8a11234",
    "67e2b9c1f8c2a4d0b8a11235"
  ]
}
```

### POST /api/admin/products/:id/auto-price

Request:

```json
{
  "targetCurrencies": ["SAR", "EGP", "USD"]
}
```

### PUT /api/admin/booking

Request:

```json
{
  "blockedExecutionDates": ["2026-03-20", "2026-03-21"]
}
```

### POST /api/admin/upload/image

Request: multipart/form-data

- file: image/png (required)
- oldUrl: https://res.cloudinary.com/... (optional)

Success response:

```json
{
  "success": true,
  "data": {
    "url": "https://res.cloudinary.com/.../image/upload/v1/...",
    "publicId": "products/abc123"
  }
}
```

## 4) Cron / Operational Route

### POST /api/admin/exchange/update-prices

Request body: none

Success response:

```json
{
  "success": true,
  "message": "Updated 35 products",
  "totalProducts": 40,
  "updatedCount": 35,
  "targetCurrencies": ["SAR", "EGP", "USD"],
  "duration": 2813
}
```

## Notes

- Mutable endpoints use centralized Zod-based request validation.
- Invalid payloads now return standardized validation errors with a `details` field.
- Payment webhook processing is signature-gated and idempotent.
