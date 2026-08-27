/**
 * Strip a product object down to only the fields needed by the
 * public frontend apps (manasik-v2 and ghadaq).
 *
 * This is applied AFTER price resolution (which already strips `prices[]`).
 * It removes admin-only and internal fields that the frontend never uses,
 * reducing payload size and preventing data leakage.
 *
 * Admin panel requests (no `platform` param) bypass this stripping
 * and receive the full product document.
 */

/** Fields kept on the product object for public API responses. */
const PUBLIC_PRODUCT_FIELDS = new Set([
  '_id',
  'name',
  'slug',
  'content',
  'baseCurrency',
  'inStock',
  'isBestSeller',
  'label',
  'showAlways',
  'isActive',
  'supportsHalfPayment',
  'media',
  'sizes',
  'partialPayment',
  'upgradeTo',
  'upgradeDiscount',
  'upgradeFeatures',
  'recommendProduct',
  'workAsSacrifice',
  'sacrificeCount',
  'reservationFields',
  'updatedAt',
]);

/** Fields kept on each size object for public API responses. */
const PUBLIC_SIZE_FIELDS = new Set([
  '_id',
  'name',
  'resolvedPrices',
  'feedsUp',
  'isAvailable',
]);

/**
 * Strip a single product object (lean document) to only public fields.
 * Mutates the object in place and also returns it.
 */
export function stripProductForPublic(
  product: Record<string, unknown>,
): Record<string, unknown> {
  // Remove top-level fields not in the whitelist
  for (const key of Object.keys(product)) {
    if (!PUBLIC_PRODUCT_FIELDS.has(key)) {
      delete product[key];
    }
  }

  // Strip each size to only public fields
  const sizes = product.sizes;
  if (Array.isArray(sizes)) {
    for (const size of sizes) {
      if (size && typeof size === 'object') {
        const sizeObj = size as Record<string, unknown>;
        for (const key of Object.keys(sizeObj)) {
          if (!PUBLIC_SIZE_FIELDS.has(key)) {
            delete sizeObj[key];
          }
        }
      }
    }
  }

  return product;
}

/**
 * Strip an array of product objects for public API responses.
 * Mutates in place and returns the array.
 */
export function stripProductsForPublic(
  products: Record<string, unknown>[],
): Record<string, unknown>[] {
  for (const product of products) {
    stripProductForPublic(product);
  }
  return products;
}
