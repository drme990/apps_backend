import { randomBytes, createHash } from 'crypto';
import Product from '@/lib/models/Product';
import PaymentLink from '@/lib/models/PaymentLink';
import { logActivity } from '@/lib/services/logger';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;
const PAY_LINK_TTL_MS = 12 * 60 * 60 * 1000;
export const EASYKASH_CURRENCIES = ['EGP', 'USD', 'SAR', 'EUR'] as const;

export class PaymentLinkError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type OrderLite = {
  _id: { toString(): string };
  orderNumber: string;
  source?: 'manasik' | 'ghadaq';
  status: string;
  remainingAmount?: number;
  currency: string;
  items?: Array<{ productSlug?: string; productId?: string }>;
};

type AdminUser = {
  userId: string;
  name: string;
  email: string;
};

type SourceType = 'manasik' | 'ghadaq';

function normalizeSource(source?: string): SourceType {
  return source === 'ghadaq' ? 'ghadaq' : 'manasik';
}

async function resolveProductSlug(order: OrderLite): Promise<string> {
  const primaryItem = order.items?.[0];
  if (!primaryItem) {
    throw new PaymentLinkError('Order items are missing', 400);
  }

  if (primaryItem.productSlug) return primaryItem.productSlug;

  if (!primaryItem.productId || !OBJECT_ID_REGEX.test(primaryItem.productId)) {
    throw new PaymentLinkError(
      'Unable to resolve product slug for this order.',
      400,
    );
  }

  const product = await Product.findById(primaryItem.productId, {
    slug: 1,
  }).lean();
  if (!product?.slug) {
    throw new PaymentLinkError(
      'Unable to resolve product slug for this order.',
      400,
    );
  }

  return product.slug;
}

export async function createPayLinkForOrder({
  order,
  user,
  customAmount,
}: {
  order: OrderLite;
  user: AdminUser;
  customAmount?: number;
}) {
  const remainingAmount = order.remainingAmount || 0;

  if (remainingAmount <= 0) {
    throw new PaymentLinkError(
      'This order has no remaining balance to collect.',
      400,
    );
  }

  if (order.status === 'cancelled' || order.status === 'refunded') {
    throw new PaymentLinkError(
      `Cannot create pay link for ${order.status} orders.`,
      400,
    );
  }

  const amountRequested = customAmount ?? remainingAmount;
  if (!Number.isFinite(amountRequested) || amountRequested <= 0) {
    throw new PaymentLinkError(
      'Pay link amount must be greater than zero.',
      400,
    );
  }

  if (amountRequested > remainingAmount) {
    throw new PaymentLinkError(
      'Custom amount cannot exceed order remaining amount.',
      400,
    );
  }

  const productSlug = await resolveProductSlug(order);

  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + PAY_LINK_TTL_MS);

  const source = normalizeSource(order.source);

  await PaymentLink.create({
    kind: 'order',
    tokenHash,
    orderId: order._id.toString(),
    orderNumber: order.orderNumber,
    source,
    amountRequested,
    currencyCode: order.currency,
    isCustomAmount: customAmount !== undefined,
    expiresAt,
    createdBy: {
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
    },
  });

  const sourceBaseUrls: Record<string, string> = {
    manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
    ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
  };

  const payLinkUrl = `${sourceBaseUrls[source]}/payment/pay-link/${rawToken}`;

  await logActivity({
    userId: user.userId,
    userName: user.name,
    userEmail: user.email,
    action: 'create',
    resource: 'order',
    resourceId: order._id.toString(),
    details:
      customAmount !== undefined
        ? `Created custom pay link for order ${order.orderNumber} with amount ${amountRequested} ${order.currency} (expires in 12h).`
        : `Created pay link for order ${order.orderNumber} (remaining ${remainingAmount} ${order.currency}, expires in 12h).`,
  });

  return {
    payLinkUrl,
    expiresAt,
    orderNumber: order.orderNumber,
    source,
    amountRequested,
    remainingAmount,
    currency: order.currency,
    productSlug,
  };
}

export async function createStandaloneCustomPayLink({
  amount,
  currencyCode,
  source,
  user,
}: {
  amount: number;
  currencyCode: string;
  source?: string;
  user: AdminUser;
}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentLinkError('Custom amount must be greater than zero.', 400);
  }

  const normalizedCurrency = currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedCurrency)) {
    throw new PaymentLinkError(
      'Currency code must be a valid 3-letter ISO code.',
      400,
    );
  }

  const normalizedSource = normalizeSource(source);
  const rawToken = randomBytes(24).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + PAY_LINK_TTL_MS);

  await PaymentLink.create({
    kind: 'custom',
    tokenHash,
    source: normalizedSource,
    amountRequested: amount,
    currencyCode: normalizedCurrency,
    isCustomAmount: true,
    expiresAt,
    createdBy: {
      userId: user.userId,
      userName: user.name,
      userEmail: user.email,
    },
  });

  const sourceBaseUrls: Record<string, string> = {
    manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
    ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
  };

  const payLinkUrl = `${sourceBaseUrls[normalizedSource]}/payment/custom-pay-link/${rawToken}`;

  await logActivity({
    userId: user.userId,
    userName: user.name,
    userEmail: user.email,
    action: 'create',
    resource: 'order',
    details: `Created standalone custom pay link: ${amount} ${normalizedCurrency} (${normalizedSource}, expires in 12h).`,
  });

  return {
    payLinkUrl,
    expiresAt,
    source: normalizedSource,
    amountRequested: amount,
    currency: normalizedCurrency,
    orderNumber: null,
    remainingAmount: null,
  };
}
