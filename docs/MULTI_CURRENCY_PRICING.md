# Multi-Currency Pricing System

## Overview

The multi-currency pricing system allows administrators to set product prices in multiple currencies. Prices can be set manually for specific currencies (e.g., SAR, EGP) while other currencies are automatically calculated using live exchange rates.

## Architecture

### Exchange Rate API

We use the **fawazahmed0 Currency API** for exchange rate data:
- **Endpoint**: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/{currency}.json`
- **Benefits**: 
  - Free, no API key required
  - CDN-cached for fast response
  - Reliable and up-to-date rates
  - No rate limits

### Database Schema

#### Product Model
```typescript
{
  // Legacy single price (for backward compatibility)
  price: number,
  currency: string,
  
  // Multi-currency pricing
  mainCurrency: string,        // Base currency for conversions (e.g., "SAR")
  prices: [
    {
      currencyCode: string,    // e.g., "USD", "EGP", "SAR"
      amount: number,           // Price in this currency
      isManual: boolean         // true = manually set, false = auto-calculated
    }
  ],
}
```

## How It Works

### 1. Setting Prices (Admin Interface)

Administrators can:

1. **Select Main Currency**: Choose the base currency (e.g., SAR) for the product
2. **Set Base Price**: Enter the price in the main currency
3. **Auto-Calculate**: Click to automatically calculate prices for all active currencies
4. **Manual Override**: Click the lock icon (🔒) next to any currency to set a manual price

#### Manual vs Auto Prices

- **Manual Prices** (🔒 locked):
  - Set by the administrator
  - Won't be overwritten by auto-calculation
  - Useful for pricing strategies (e.g., round numbers, market-specific pricing)
  
- **Auto Prices** (🔓 unlocked):
  - Calculated from base price using exchange rates
  - Update when you click "Auto Calculate Prices"
  - Based on live exchange rates

### 2. API Endpoints

#### Get Exchange Rates
```http
GET /api/currency/rates?base=SAR
```

Response:
```json
{
  "success": true,
  "data": {
    "base": "SAR",
    "rates": {
      "USD": 0.266,
      "EGP": 13.2,
      "AED": 0.98,
      ...
    }
  }
}
```

#### Convert Currency
```http
GET /api/currency/rates?base=SAR&target=USD&amount=100
```

Response:
```json
{
  "success": true,
  "data": {
    "from": "SAR",
    "to": "USD",
    "amount": 100,
    "converted": 26.6
  }
}
```

#### Auto-Price Product
```http
POST /api/products/[id]/auto-price
Content-Type: application/json

{
  "overrideManual": false  // Optional: if true, overwrites manual prices too
}
```

### 3. Currency Service (`lib/currency.ts`)

#### Key Functions

##### `getExchangeRates(baseCurrency: string)`
Fetches exchange rates for a base currency with 6-hour caching.

##### `convertCurrency(amount: number, from: string, to: string)`
Converts an amount between two currencies.

##### `convertToMultipleCurrencies(amount: number, base: string, targets: string[])`
Converts a price to multiple currencies at once.

## Usage Examples

### Creating a Product with Multi-Currency Pricing

```typescript
const productData = {
  name: { ar: "عمرة البدل", en: "Umrah by Proxy" },
  description: { ar: "...", en: "..." },
  price: 2000,                 // Base price
  currency: "SAR",             // Legacy field
  mainCurrency: "SAR",         // Main currency for conversions
  prices: [
    { currencyCode: "SAR", amount: 2000, isManual: true },   // Manually set
    { currencyCode: "USD", amount: 533, isManual: false },   // Auto-calculated
    { currencyCode: "EGP", amount: 26400, isManual: true },  // Manually set
    { currencyCode: "AED", amount: 1960, isManual: false }   // Auto-calculated
  ],
  inStock: true
};

await fetch('/api/products', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(productData)
});
```

### Auto-Calculating Prices

```typescript
// Calculate prices for all active currencies
await fetch(`/api/products/${productId}/auto-price`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ overrideManual: false })
});
```

### Getting Price in User's Currency

```typescript
// In your frontend:
const product = await fetchProduct(id);
const userCurrency = getUserCurrency(); // e.g., from country selection

// Get price for user's currency
const priceInUserCurrency = product.prices.find(
  p => p.currencyCode === userCurrency
);

// Fallback to main price if not found
const displayPrice = priceInUserCurrency?.amount || product.price;
const displayCurrency = priceInUserCurrency?.currencyCode || product.currency;
```

## Admin UI Components

### MultiCurrencyPriceEditor

Located at: `components/admin/multi-currency-price-editor.tsx`

**Props:**
- `mainCurrency`: Current main currency
- `basePrice`: Base price in main currency
- `prices`: Array of currency prices
- `onChange`: Callback when prices change
- `onMainCurrencyChange`: Callback when main currency changes
- `onBasePriceChange`: Callback when base price changes

**Features:**
- Fetches active countries/currencies from API
- Auto-calculates prices using live exchange rates
- Allows manual price override with lock/unlock toggle
- Visual indicators for manual vs auto prices
- Responsive grid layout

## Best Practices

1. **Set Main Currency Wisely**: Choose the currency you primarily work with as the main currency
2. **Use Manual Prices for Key Markets**: Set manual prices for your main markets (e.g., SAR, EGP) to ensure round numbers
3. **Auto-Calculate Regularly**: Run auto-calculation periodically to keep prices up-to-date with exchange rates
4. **Cache Considerations**: Exchange rates are cached for 6 hours; force refresh by restarting the server if needed
5. **Testing**: Always test price calculations after changes to ensure accuracy

## Backward Compatibility

The system maintains backward compatibility with the old single-price system:
- `price` and `currency` fields are still supported
- If `mainCurrency` is not set, it defaults to `currency`
- If `prices` array is empty, system falls back to single `price` field

## Troubleshooting

### Exchange Rate API Errors

If the API fails:
1. Check network connectivity
2. Verify the API is accessible: `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/sar.json`
3. Check cache - old rates are used as fallback
4. Review server logs for specific errors

### Prices Not Updating

1. Verify the product has a `mainCurrency` set
2. Check that currencies exist in active countries
3. Ensure base price is greater than 0
4. Review browser console for API errors

### Manual Prices Being Overwritten

Check the `isManual` flag:
- Must be `true` to protect from auto-calculation
- Use the lock icon (🔒) in the UI to toggle manual mode
- Pass `overrideManual: false` when calling auto-price endpoint

## Future Enhancements

- [ ] Scheduled auto-price updates (daily/weekly)
- [ ] Price history tracking
- [ ] Currency conversion fees/margins
- [ ] Bulk price operations for multiple products
- [ ] Exchange rate alerts for significant changes
- [ ] Custom exchange rate overrides for specific currencies
