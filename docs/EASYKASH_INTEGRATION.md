# EasyKash Direct Payment Integration

This document describes how the **EasyKash Direct Payment API v1** is integrated into the Ghadaq application.

---

## Overview

EasyKash processes all payments for the platform. When a customer checks out, the app creates a payment request via the EasyKash API, redirects the user to EasyKash's hosted payment page, and receives a callback webhook when payment completes.

---

## Environment Variables

```env
EASYKASH_API_KEY=your-easykash-api-key
EASYKASH_HMAC_SECRET=your-easykash-hmac-secret
```

---

## Flow

```
Customer fills checkout form
        ↓
POST /api/payment/checkout
  → Creates Order in MongoDB (status: pending)
  → Calls EasyKash Pay API
  → Returns redirect URL
        ↓
Customer redirected to EasyKash payment page
        ↓
Customer completes payment
        ↓
EasyKash redirects back to /payment/status?orderNumber=xxx
  → Page polls /api/payment/status for order status
        ↓
EasyKash sends POST callback to /api/payment/webhook
  → HMAC SHA-512 signature verified
  → Order updated (status: completed, payment details saved)
  → FB Conversions API Purchase event fired
```

---

## API Endpoints

### EasyKash External APIs

| Endpoint                                         | Method | Description            |
| ------------------------------------------------ | ------ | ---------------------- |
| `https://back.easykash.net/api/directpayv1/pay`  | POST   | Create a payment       |
| `https://back.easykash.net/api/cash-api/inquire` | POST   | Inquire payment status |

### App API Routes

| Route                        | Method | Description                                          |
| ---------------------------- | ------ | ---------------------------------------------------- |
| `/api/payment/checkout`      | POST   | Create order + EasyKash payment, return redirect URL |
| `/api/payment/webhook`       | POST   | Receive EasyKash callback, verify HMAC, update order |
| `/api/payment/status`        | GET    | Get order status by `orderNumber` query param        |
| `/api/payment/referral-info` | GET    | Get referral info by `orderNumber`                   |

---

## Pay Request

```json
{
  "amount": 1500,
  "currency": "EGP",
  "paymentOptions": [2, 3, 4, 5, 6],
  "cashExpiry": 24,
  "name": "Customer Name",
  "email": "customer@example.com",
  "mobile": "+201234567890",
  "redirectUrl": "https://www.ghadaqplus.com/payment/status?orderNumber=GHD-xxx",
  "customerReference": "GHD-xxx"
}
```

**Headers:** `api-key: EASYKASH_API_KEY`

**Response:**

```json
{
  "redirectUrl": "https://www.easykash.net/DirectPayV1/{productCode}"
}
```

---

## Callback Webhook

EasyKash sends a POST to `/api/payment/webhook` with:

```json
{
  "ProductCode": "abc123",
  "PaymentMethod": "Card",
  "ProductType": "...",
  "Amount": "1500",
  "BuyerEmail": "customer@example.com",
  "BuyerMobile": "+201234567890",
  "BuyerName": "Customer Name",
  "Timestamp": "2025-01-01T00:00:00Z",
  "status": "PAID",
  "voucher": "...",
  "easykashRef": "ref123",
  "VoucherData": "...",
  "customerReference": "GHD-xxx",
  "signatureHash": "abc123..."
}
```

### HMAC Verification

The signature is verified by:

1. Concatenating: `ProductCode + Amount + ProductType + PaymentMethod + status + easykashRef + customerReference`
2. Computing HMAC SHA-512 with `EASYKASH_HMAC_SECRET`
3. Comparing the hex digest with `signatureHash`

### Payment Method Mapping

| EasyKash Value    | Stored As |
| ----------------- | --------- |
| Contains "card"   | `card`    |
| Contains "wallet" | `wallet`  |
| Contains "fawry"  | `fawry`   |
| Contains "meeza"  | `meeza`   |
| Contains "valu"   | `valu`    |
| Other             | `other`   |

---

## Order Fields (EasyKash-specific)

| Field                 | Description                           |
| --------------------- | ------------------------------------- |
| `easykashRef`         | EasyKash reference ID from callback   |
| `easykashProductCode` | Product code from callback            |
| `easykashVoucher`     | Voucher string from callback          |
| `easykashResponse`    | Full callback payload (for debugging) |

---

## Key Files

| File                                | Purpose                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `lib/easykash.ts`                   | API client: `createPayment()`, `verifyCallbackSignature()`, `inquirePayment()` |
| `app/api/payment/checkout/route.ts` | Checkout endpoint                                                              |
| `app/api/payment/webhook/route.ts`  | Webhook handler                                                                |
| `app/api/payment/status/route.ts`   | Status lookup                                                                  |
| `app/payment/status/page.tsx`       | Payment status UI                                                              |

---

## Inquiry API

For checking payment status programmatically:

```json
POST https://back.easykash.net/api/cash-api/inquire
{
  "customerReference": "GHD-xxx"
}
```

Returns payment status and details.
