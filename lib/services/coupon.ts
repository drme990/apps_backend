import Coupon, { type ICoupon } from '../models/Coupon';
import { countryNameToCode } from '../country-visibility';

export interface CouponValidationResult {
  valid: boolean;
  error?: string;
  coupon?: ICoupon;
  discountAmount?: number;
}

export async function validateCoupon(
  code: string,
  orderAmount: number,
  currency: string,
  productId?: string,
  detectedCountry?: string | null,
): Promise<CouponValidationResult> {
  const coupon = await Coupon.findOne({ code: code.toUpperCase().trim() });

  if (!coupon) return { valid: false, error: 'COUPON_NOT_FOUND' };
  if (coupon.status !== 'active')
    return { valid: false, error: 'COUPON_NOT_ACTIVE' };

  const now = new Date();
  if (coupon.validFrom && now < new Date(coupon.validFrom))
    return { valid: false, error: 'COUPON_NOT_STARTED' };
  if (coupon.validUntil && now > new Date(coupon.validUntil))
    return { valid: false, error: 'COUPON_EXPIRED' };
  if (coupon.maxUses && coupon.usedCount >= coupon.maxUses)
    return { valid: false, error: 'COUPON_MAX_USES_REACHED' };
  if (coupon.minOrderAmount && orderAmount < coupon.minOrderAmount)
    return { valid: false, error: 'COUPON_MIN_ORDER_NOT_MET' };

  if (coupon.allowedCountries && coupon.allowedCountries.length > 0) {
    // Convert country name to ISO code if it's a full name
    const countryCode = countryNameToCode(detectedCountry || '');
    
    // If no detected country is available but coupon has country restrictions,
    // we cannot validate - allow it to pass for now or return error
    // For now, we'll allow it if no country is detected
    if (countryCode && !coupon.allowedCountries.includes(countryCode)) {
      return { valid: false, error: 'COUPON_NOT_AVAILABLE_IN_COUNTRY' };
    }
  }

  if (
    coupon.applicableProducts &&
    coupon.applicableProducts.length > 0 &&
    productId
  ) {
    if (!coupon.applicableProducts.includes(productId))
      return { valid: false, error: 'COUPON_NOT_APPLICABLE' };
  }

  let discountAmount = 0;
  if (coupon.type === 'percentage') {
    discountAmount = (orderAmount * coupon.value) / 100;
  } else {
    const normalizedCurrency = currency.trim().toUpperCase();
    const fixedPrice = (coupon.fixedPrices || []).find(
      (price) => price.currencyCode.toUpperCase() === normalizedCurrency,
    );

    if (!fixedPrice) {
      return { valid: false, error: 'COUPON_CURRENCY_NOT_SUPPORTED' };
    }

    discountAmount = fixedPrice.amount;
  }

  const normalizedCurrency = currency.trim().toUpperCase();
  const maxDiscountPrice = (coupon.maxDiscountPrices || []).find(
    (price) => price.currencyCode.toUpperCase() === normalizedCurrency,
  );
  const maxDiscountAmount =
    maxDiscountPrice?.amount ?? coupon.maxDiscountAmount;

  if (maxDiscountAmount && discountAmount > maxDiscountAmount) {
    discountAmount = maxDiscountAmount;
  }
  if (discountAmount > orderAmount) {
    discountAmount = orderAmount;
  }

  discountAmount = Math.round(discountAmount * 100) / 100;

  return { valid: true, coupon: coupon.toObject(), discountAmount };
}

export async function applyCoupon(code: string): Promise<boolean> {
  const result = await Coupon.findOneAndUpdate(
    { code: code.toUpperCase().trim() },
    { $inc: { usedCount: 1 } },
  );
  return !!result;
}
