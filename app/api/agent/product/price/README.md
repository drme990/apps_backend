# Agent Product Price API

Returns product prices for a given product and user country, applying the admin-configured country visibility rules (real price vs. exchange price).

## Endpoint

```
GET|POST /api/agent/product/price
```

Both `GET` (query params) and `POST` (JSON body, or query params as fallback) are supported.

## Request

### Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `productId` | `string` | Yes | MongoDB ObjectId of the product |
| `country` | `string` | Yes | 2-letter country code (e.g. `EG`, `SA`) **or** country name in English/Arabic (e.g. `Egypt`, `مصر`) |

### GET example

```bash
curl "https://your-domain.com/api/agent/product/price?productId=69947e005c9e1211c34a6b75&country=eg"
```

### POST example

```bash
curl -X POST "https://your-domain.com/api/agent/product/price" \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "69947e005c9e1211c34a6b75",
    "country": "eg"
  }'
```

### POST with query params (empty/no body)

```bash
curl -X POST "https://your-domain.com/api/agent/product/price?productId=69947e005c9e1211c34a6b75&country=eg"
```

## Response

### Success — `200 OK`

```json
{
  "success": true,
  "data": {
    "productId": "69947e005c9e1211c34a6b75",
    "productName": {
      "ar": "...",
      "en": "..."
    },
    "slug": "...",
    "countryCode": "EG",
    "countryName": {
      "ar": "مصر",
      "en": "Egypt"
    },
    "mainCurrencyCode": "EGP",
    "baseCurrency": "EGP",
    "sizes": [
      {
        "sizeId": "...",
        "sizeName": {
          "ar": "...",
          "en": "..."
        },
        "available": true,
        "prices": [
          {
            "countryCode": "EG",
            "countryName": {
              "ar": "مصر",
              "en": "Egypt"
            },
            "currencyCode": "EGP",
            "price": 2500,
            "type": "real",
            "isManual": true
          },
          {
            "countryCode": "SA",
            "countryName": {
              "ar": "السعودية",
              "en": "Saudi Arabia"
            },
            "currencyCode": "SAR",
            "price": 185,
            "type": "exchange"
          }
        ]
      }
    ]
  }
}
```

### Field descriptions

| Field | Description |
|-------|-------------|
| `productId` | Product ID |
| `productName` | Product name in Arabic and English |
| `slug` | Product slug |
| `countryCode` | Resolved user country code |
| `countryName` | User country name in Arabic and English |
| `mainCurrencyCode` | User country's currency (used as base for exchange conversions) |
| `baseCurrency` | Product's configured base currency |
| `sizes` | Array of available sizes. Unavailable sizes (`isAvailable: false`) are filtered out. |
| `sizes[].sizeId` | Size ID |
| `sizes[].sizeName` | Size name in Arabic and English |
| `sizes[].available` | Whether the size is available |
| `sizes[].prices` | Array of visible prices for this size |
| `sizes[].prices[].countryCode` | Country code this price belongs to |
| `sizes[].prices[].countryName` | Country name in Arabic and English |
| `sizes[].prices[].currencyCode` | Currency code of the price |
| `sizes[].prices[].price` | Final price value |
| `sizes[].prices[].type` | `"real"` or `"exchange"` |
| `sizes[].prices[].isManual` | `true` if the real price was explicitly set in the product editor. Only present for `type: "real"`. |

## How prices are determined

1. The user's country is resolved from the `country` parameter.
2. The route loads all countries and uses `getVisibleCountriesForViewer` to get the list of countries/currencies the user is allowed to see.
3. For each visible country:
   - **Real price** (`realPrice: true`): Uses the explicit price in `size.prices` for that country's currency. If no explicit price exists and the product's `baseCurrency` matches, the base `size.price` is used.
   - **Exchange price** (`exchangePrice: true`): Converts the user's main currency price to the target currency using live exchange rates, then applies the target currency's rounding rule.
   - If both are enabled, real price is preferred.

If exchange rates cannot be fetched, exchange prices are skipped but real prices still return.

## Error responses

| Status | Error | When |
|--------|-------|------|
| `400` | `productId is required` | `productId` is missing |
| `400` | `country is required` | `country` is missing |
| `400` | `Invalid product id` | `productId` is not a valid MongoDB ObjectId |
| `404` | `Country not found` | The provided country code/name does not exist in the database |
| `404` | `Product not found` | Product not found, inactive, or deleted |
| `500` | `Failed to fetch product price` | Unexpected server error |

### Example error

```json
{
  "success": false,
  "error": "productId is required"
}
```

## Notes

- Prices are rounded according to each currency's configured `roundingRule` in the `countries` collection (`nearest-ten`, `nearest-five`, `nearest-fifty`, `nearest-hundred`, or `ceil`).
- The response includes prices for **all visible countries**, not only the user's own country.
