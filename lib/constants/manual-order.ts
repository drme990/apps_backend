/**
 * Special placeholder product ID for manual orders.
 *
 * When the admin creates a manual order with a custom product name
 * (instead of picking an existing product), the order item's
 * `productId` is set to this value. The design app has a matching
 * "Manual Order" booking product that the admin can connect to any
 * template — just like a real product.
 *
 * This constant must match the one in the design app's
 * `lib/store/backend-products.ts`.
 */
export const MANUAL_ORDER_PRODUCT_ID = '__manual_order__';

/**
 * Check if a product ID is the manual order placeholder.
 */
export function isManualOrderProductId(productId: string | undefined | null): boolean {
  return Boolean(productId) && productId === MANUAL_ORDER_PRODUCT_ID;
}
