# EasyKash Direct Payment Integration (v1)

This document explains how **EasyKash Direct Payment API v1** is integrated into the **Ghadaq** platform, including payment flow, API endpoints, webhook verification, and order data handling.

---

# 1. Overview

EasyKash is the payment processor used by Ghadaq. The platform does **not** process card data directly. Instead:

1. Customer creates an order on Ghadaq.
2. Ghadaq requests a payment session from EasyKash.
3. Customer is redirected to EasyKash hosted payment page.
4. Customer completes payment.
5. EasyKash sends a **server-to-server webhook** to confirm payment.
6. Ghadaq updates the order status.
7. Customer is redirected back to the payment status page.

---

# 2. Environment Variables

Add the following environment variables to your project:

```env
EASYKASH_API_KEY=your-easykash-api-key
EASYKASH_HMAC_SECRET=your-easykash-hmac-secret
EASYKASH_CASH_EXPIRY_HOURS=3
EASYKASH_BASE_URL=https://back.easykash.net
NEXT_PUBLIC_BASE_URL=https://www.ghadaqplus.com
```

---

# 3. Payment Flow

```
Customer fills checkout form
        ↓
POST /api/payment/checkout
        ↓
Create Order in MongoDB (status: pending)
        ↓
Call EasyKash /directpayv1/pay
        ↓
Receive redirectUrl
        ↓
Redirect customer to EasyKash hosted page
        ↓
Customer pays
        ↓
EasyKash redirects user to:
 /payment/status?orderNumber=XXX
        ↓
Frontend polls:
/api/payment/status
        ↓
EasyKash sends webhook:
/api/payment/webhook
        ↓
Verify HMAC signature
        ↓
Update order status to paid or partially-paid
        ↓
Store payment details
        ↓
Fire Facebook Conversions API Purchase event
```

---

# 4. EasyKash External APIs

| Endpoint              | Method | Purpose                |
| --------------------- | ------ | ---------------------- |
| /api/directpayv1/pay  | POST   | Create payment session |
| /api/cash-api/inquire | POST   | Check payment status   |

Base URL:

```
https://back.easykash.net
```

---

# 5. Create Payment Request

## Endpoint

```
POST https://back.easykash.net/api/directpayv1/pay
```

### Headers

```http
api-key: EASYKASH_API_KEY
Content-Type: application/json
```

### Request Body

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

### Response

```json
{
  "redirectUrl": "https://www.easykash.net/DirectPayV1/{productCode}"
}
```

You must **redirect the user** to this URL.

---

# 6. Webhook Callback

EasyKash sends a **POST** request to:

```
POST /api/payment/webhook
```

## Webhook Payload

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

---

# 7. HMAC Signature Verification (IMPORTANT)

To verify that the request is from EasyKash:

## Step 1 — Concatenate fields in this exact order:

```
ProductCode + Amount + ProductType + PaymentMethod + status + easykashRef + customerReference
```

### Step 2 — Generate HMAC SHA-512 using:

```
EASYKASH_HMAC_SECRET
```

### Step 3 — Compare result with:

```
signatureHash
```

If the signature **does not match**, reject the webhook.

---

# 8. Payment Status Values

| EasyKash Status | Meaning             | Action                                                         |
| --------------- | ------------------- | -------------------------------------------------------------- |
| PAID            | Payment successful  | Mark order as paid or partially-paid based on remaining amount |
| PENDING         | Waiting for payment | Keep pending                                                   |
| EXPIRED         | Cash expired        | Mark failed                                                    |
| FAILED          | Payment failed      | Mark failed                                                    |

---

# 9. Payment Method Mapping

| EasyKash Value | Stored Value |
| -------------- | ------------ |
| Card           | card         |
| Wallet         | wallet       |
| Fawry          | fawry        |
| Meeza          | meeza        |
| Valu           | valu         |
| Other          | other        |

Example implementation:

```ts
function mapPaymentMethod(method: string) {
  const m = method.toLowerCase();
  if (m.includes("card")) return "card";
  if (m.includes("wallet")) return "wallet";
  if (m.includes("fawry")) return "fawry";
  if (m.includes("meeza")) return "meeza";
  if (m.includes("valu")) return "valu";
  return "other";
}
```

---

# 10. Order Fields Stored (EasyKash)

These fields should be stored in the order document:

| Field               | Description                 |
| ------------------- | --------------------------- |
| easykashRef         | EasyKash reference          |
| easykashProductCode | Product code                |
| easykashVoucher     | Voucher                     |
| easykashResponse    | Full webhook payload        |
| paymentMethod       | card / wallet / fawry / etc |
| paidAt              | Payment timestamp           |

---

# 11. App API Routes

| Route                      | Method | Description            |
| -------------------------- | ------ | ---------------------- |
| /api/payment/checkout      | POST   | Create order + payment |
| /api/payment/webhook       | POST   | EasyKash webhook       |
| /api/payment/status        | GET    | Get order status       |
| /api/payment/referral-info | GET    | Referral info          |

---

# 12. Payment Status Polling

After redirect:

```
/payment/status?orderNumber=GHD-xxx
```

Frontend should poll every **5–10 seconds**:

```
GET /api/payment/status?orderNumber=GHD-xxx
```

Response:

```json
{
  "status": "pending | completed | failed",
  "paymentMethod": "card",
  "amount": 1500
}
```

Stop polling when status != pending.

---

# 13. Inquiry API (Fail-Safe)

If webhook fails, use inquiry API:

## Request

```
POST https://back.easykash.net/api/cash-api/inquire
```

```json
{
  "customerReference": "GHD-xxx"
}
```

Use this in:

- Cron job
- Manual admin check
- Payment reconciliation script

---

# 14. Security Best Practices

- Always verify **HMAC signature**
- Never trust redirect alone — trust **webhook**
- Webhook must be **idempotent**
- Do not mark order as paid without webhook
- Log full webhook response
- Use HTTPS only
- Restrict webhook route to POST only

---

# 15. Failure Handling

| Scenario                 | Action                   |
| ------------------------ | ------------------------ |
| User closes payment page | Order remains pending    |
| Webhook delayed          | Status polling continues |
| Webhook fails            | Use Inquiry API          |
| Payment expired          | Mark failed              |
| Duplicate webhook        | Ignore (idempotent)      |

Notes:

- Keep local payment-link expiry aligned with `cashExpiry` sent to EasyKash.
- For partial checkout orders, first successful payment sets order to `partially-paid`; remaining payment success sets order to `paid`.

---

# 16. Key Files

| File                              | Description         |
| --------------------------------- | ------------------- |
| lib/easykash.ts                   | EasyKash API client |
| app/api/payment/checkout/route.ts | Checkout endpoint   |
| app/api/payment/webhook/route.ts  | Webhook handler     |
| app/api/payment/status/route.ts   | Status lookup       |
| app/payment/status/page.tsx       | Payment status UI   |

---

# 17. Summary Flow Diagram

```
User → Ghadaq → EasyKash → User
                ↓
             Webhook
                ↓
              Ghadaq
                ↓
            Update Order
```

---

# 18. Testing Checklist

- [ ] Payment created successfully
- [ ] Redirect works
- [ ] Webhook received
- [ ] HMAC verified
- [ ] Order marked completed
- [ ] Payment method saved
- [ ] FB Purchase event fired
- [ ] Status page updates
- [ ] Inquiry API works
- [ ] Duplicate webhook handled
