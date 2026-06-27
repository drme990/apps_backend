import mongoose from 'mongoose';
import OrderSequence from '@/lib/models/OrderSequence';
import Category from '@/lib/models/Categories';
import { calculateOrderFinancials } from '@/lib/services/order-financials';

function getMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getDailyDateStamp(): string {
  const now = new Date();
  return `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function getCategoryNumberForProduct(
  productId: mongoose.Types.ObjectId | string | undefined,
): Promise<number> {
  if (!productId) return 9999;
  try {
    const category = await Category.findOne({ products: productId })
      .select('categoryNumber')
      .lean();
    return category?.categoryNumber ?? 9999;
  } catch {
    return 9999;
  }
}

async function allocateOrderNumber(opts: {
  ref: string;
  categoryNumber: number;
  source: 'manasik' | 'ghadaq' | undefined;
}): Promise<string> {
  const { ref, categoryNumber } = opts;
  const monthKey = getMonthKey();
  const dateStamp = getDailyDateStamp();
  const maxRetries = 5;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      // Ensure sequence document exists for this month (resets every month).
      await OrderSequence.updateOne(
        { _id: monthKey },
        { $setOnInsert: { seq: 0 } },
        { upsert: true },
      ).exec();

      // Atomically allocate the next sequence number.
      const counter = await OrderSequence.findOneAndUpdate(
        { _id: monthKey },
        { $inc: { seq: 1 } },
        { new: true },
      ).lean();

      const nextSeq = Number(counter?.seq || 0);
      if (nextSeq > 0) {
        return `${ref}-${dateStamp}-${categoryNumber}-${String(nextSeq).padStart(4, '0')}`;
      }
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 11000 && attempt < maxRetries - 1) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Failed to allocate order number for month ${monthKey}`);
}

export type OrderStatus =
  | 'pending'
  | 'processing'
  | 'partial-paid'
  | 'paid'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelled';

export type PaymentMethod =
  | 'card'
  | 'wallet'
  | 'bank_transfer'
  | 'fawry'
  | 'meeza'
  | 'valu'
  | 'other'
  | 'easykash'
  | 'insta_pay'
  | 'vodafone_cash'
  | 'paypal'
  | 'binance';

export type PaymentType = 'full' | 'half' | 'partial';

export interface IOrderItem {
  productId: mongoose.Types.ObjectId | string;
  productSlug?: string;
  productName: { ar: string; en: string };
  price: number;
  originalPrice?: number;
  currency: string;
  quantity: number;
  sizeIndex?: number;
  sizeName?: { ar: string; en: string };
}

export interface IBillingData {
  fullName: string;
  email: string;
  phone: string;
  country: string;
}

export interface IReservationAnswer {
  key:
  | 'intention'
  | 'sacrificeFor'
  | 'gender'
  | 'isAlive'
  | 'shortDuaa'
  | 'photo'
  | 'executionDate';
  label: { ar: string; en: string };
  type:
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'radio'
  | 'picture';
  value: string;
}

export interface IPayment {
  paymentId: string;
  easykashOrderId: string;
  // Amount recorded in order currency for accounting and remaining balance math.
  orderAmount?: number;
  // Raw amount sent/received at the payment gateway.
  gatewayAmount?: number;
  gatewayCurrency?: string;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'expired';
  paymentMethod?: PaymentMethod;
  easykashRef?: string;
  easykashProductCode?: string;
  easykashVoucher?: string;
  easykashResponse?: Record<string, unknown>;
  redirectUrl?: string;
  expiresAt?: Date;
  createdAt: Date;
  paidAt?: Date;
}

export interface IPaymentAttempt {
  createdAt: Date;
  ip?: string;
  userId?: string;
}

export interface IInvoiceUrl {
  url: string;
  reviewed?: boolean;
}

export interface IOrder {
  _id?: string;
  orderNumber: string;
  userId?: mongoose.Types.ObjectId | string;
  isGuest: boolean;
  items: IOrderItem[];
  totalAmount: number;
  currency: string;
  status: OrderStatus;
  location?: string;
  billingData: IBillingData;
  easykashRef?: string;
  easykashProductCode?: string;
  easykashVoucher?: string;
  easykashResponse?: Record<string, string | number | undefined>;
  couponCode?: string;
  couponId?: mongoose.Types.ObjectId | string;
  couponDiscount?: number;
  // Upgrade discount tracking
  isUpgrade?: boolean;
  fromProductId?: mongoose.Types.ObjectId | string;
  upgradeDiscount?: number;
  fullAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  isPartialPayment?: boolean;
  paymentType?: PaymentType;
  isWhatsappButtonClicked?: 'clicked' | 'not-clicked' | 'no-need-to-click';
  referralId?: string;
  cancellationReason?: string;
  invoiceUrls?: IInvoiceUrl[];
  termsAgreedAt?: Date;
  reservationData?: IReservationAnswer[];
  payments?: IPayment[];
  paymentAttempts?: IPaymentAttempt[];
  source?: 'manasik' | 'ghadaq';
  latestClientIp?: string;
  deviceFingerprint?: string;
  locale?: string;
  statusUpdateTime: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const OrderItemSchema = new mongoose.Schema<IOrderItem>(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    productSlug: { type: String, trim: true, lowercase: true },
    productName: {
      ar: { type: String, required: true },
      en: { type: String, required: true },
    },
    price: { type: Number, required: true, min: 0 },
    originalPrice: { type: Number, min: 0 },
    currency: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    sizeIndex: { type: Number, min: 0, default: 0 },
    sizeName: {
      ar: { type: String, trim: true },
      en: { type: String, trim: true },
    },
  },
  { _id: false },
);

const BillingDataSchema = new mongoose.Schema<IBillingData>(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const ReservationAnswerSchema = new mongoose.Schema<IReservationAnswer>(
  {
    key: {
      type: String,
      enum: [
        'intention',
        'sacrificeFor',
        'gender',
        'isAlive',
        'shortDuaa',
        'photo',
        'executionDate',
      ],
      required: true,
    },
    label: {
      ar: { type: String, required: true, trim: true },
      en: { type: String, required: true, trim: true },
    },
    type: {
      type: String,
      enum: [
        'text',
        'textarea',
        'number',
        'date',
        'select',
        'radio',
        'picture',
      ],
      required: true,
    },
    value: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const PaymentSchema = new mongoose.Schema<IPayment>(
  {
    paymentId: { type: String, required: true, index: true },
    easykashOrderId: { type: String, required: true, index: true },
    orderAmount: { type: Number, min: 0 },
    gatewayAmount: { type: Number, min: 0 },
    gatewayCurrency: { type: String, uppercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'paid', 'failed', 'expired'],
      default: 'pending',
      index: true,
    },
    paymentMethod: {
      type: String,
      enum: [
        'card',
        'wallet',
        'bank_transfer',
        'fawry',
        'meeza',
        'valu',
        'other',
        'easykash',
        'insta_pay',
        'vodafone_cash',
        'paypal',
        'binance',
      ],
    },
    easykashRef: { type: String, index: true },
    easykashProductCode: { type: String },
    easykashVoucher: { type: String },
    easykashResponse: { type: mongoose.Schema.Types.Mixed },
    redirectUrl: { type: String },
    expiresAt: { type: Date },
    createdAt: { type: Date, required: true, default: () => new Date() },
    paidAt: { type: Date },
  },
  { _id: false },
);

const PaymentAttemptSchema = new mongoose.Schema<IPaymentAttempt>(
  {
    createdAt: { type: Date, required: true, default: () => new Date() },
    ip: { type: String },
    userId: { type: String },
  },
  { _id: false },
);

const InvoiceUrlSchema = new mongoose.Schema<IInvoiceUrl>(
  {
    url: { type: String, required: true, trim: true },
    reviewed: { type: Boolean, default: false },
  },
  { _id: false },
);

function normalizeEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIp(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  let normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') return undefined;
  if (normalized === '::1') return '127.0.0.1';
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice('::ffff:'.length);
  }
  return normalized || undefined;
}

function inferPaymentType(order: {
  paymentType?: PaymentType;
  isPartialPayment?: boolean;
  totalAmount?: number;
  fullAmount?: number;
}): PaymentType {
  if (order.paymentType) return order.paymentType;
  if (!order.isPartialPayment) return 'full';

  const fullAmount = Number(order.fullAmount ?? 0);
  const paidNowAmount = Number(order.totalAmount ?? 0);

  if (fullAmount > 0) {
    const halfAmount = Math.ceil(fullAmount / 2);
    if (Math.abs(paidNowAmount - halfAmount) <= 1) {
      return 'half';
    }
  }

  return 'partial';
}

function extractNextStatus(
  update: Record<string, unknown> | undefined,
): string | null {
  if (!update) return null;

  const directStatus = update.status;
  if (typeof directStatus === 'string' && directStatus.trim()) {
    return directStatus.trim();
  }

  const setUpdate = update.$set;
  if (setUpdate && typeof setUpdate === 'object') {
    const setStatus = (setUpdate as Record<string, unknown>).status;
    if (typeof setStatus === 'string' && setStatus.trim()) {
      return setStatus.trim();
    }
  }

  const setOnInsert = update.$setOnInsert;
  if (setOnInsert && typeof setOnInsert === 'object') {
    const insertStatus = (setOnInsert as Record<string, unknown>).status;
    if (typeof insertStatus === 'string' && insertStatus.trim()) {
      return insertStatus.trim();
    }
  }

  return null;
}

function touchStatusUpdateTime(
  update: Record<string, unknown> | undefined,
): void {
  const nextStatus = extractNextStatus(update);
  if (!nextStatus || !update) return;

  const now = new Date();

  if (update.$set && typeof update.$set === 'object') {
    (update.$set as Record<string, unknown>).statusUpdateTime = now;
    return;
  }

  if (update.$setOnInsert && typeof update.$setOnInsert === 'object') {
    (update.$setOnInsert as Record<string, unknown>).statusUpdateTime = now;
    return;
  }

  update.statusUpdateTime = now;
}

const OrderSchema = new mongoose.Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, index: true }, // Polymorphic ref (Users_manasik, Users_ghadaq)
    isGuest: { type: Boolean, required: true, default: true, index: true },
    items: {
      type: [OrderItemSchema],
      required: true,
      validate: {
        validator: (v: IOrderItem[]) => v.length > 0,
        message: 'Order must have at least one item',
      },
    },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: [
        'pending',
        'processing',
        'partial-paid',
        'paid',
        'completed',
        'failed',
        'refunded',
        'cancelled',
      ],
      default: 'pending',
      index: true,
    },

    billingData: { type: BillingDataSchema, required: true },
    easykashRef: { type: String, index: true },
    easykashProductCode: { type: String, index: true },
    easykashVoucher: { type: String },
    easykashResponse: { type: mongoose.Schema.Types.Mixed },
    couponCode: { type: String, trim: true, uppercase: true },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon' },
    couponDiscount: { type: Number, min: 0, default: 0 },
    // Upgrade discount tracking
    isUpgrade: { type: Boolean, default: false },
    fromProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    upgradeDiscount: { type: Number, min: 0, max: 100, default: 0 },
    fullAmount: { type: Number, min: 0 },
    paidAmount: { type: Number, min: 0 },
    remainingAmount: { type: Number, min: 0 },
    isPartialPayment: { type: Boolean, default: false },
    paymentType: {
      type: String,
      enum: ['full', 'half', 'partial'],
      default: 'full',
      index: true,
    },
    isWhatsappButtonClicked: {
      type: String,
      enum: ['clicked', 'not-clicked', 'no-need-to-click'],
      default: 'no-need-to-click',
      index: true,
    },
    referralId: { type: String, trim: true, index: true },
    cancellationReason: { type: String, trim: true },
    invoiceUrls: { type: [InvoiceUrlSchema], default: [] },
    statusUpdateTime: {
      type: Date,
      required: true,
      default: () => new Date(),
      index: true,
    },
    termsAgreedAt: { type: Date },
    reservationData: { type: [ReservationAnswerSchema], default: [] },
    payments: { type: [PaymentSchema], default: [] },
    paymentAttempts: { type: [PaymentAttemptSchema], default: [] },
    source: {
      type: String,
      enum: ['manasik', 'ghadaq'],
      default: 'manasik',
      index: true,
    },
    latestClientIp: { type: String, trim: true, index: true },
    deviceFingerprint: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    location: { type: String, trim: true },
    locale: { type: String, trim: true, default: 'ar' },
  },
  { timestamps: true },
);

// Generate order number before validation
OrderSchema.pre('validate', async function () {
  if (!this.orderNumber) {
    const ref = this.referralId || (this.source === 'ghadaq' ? 'GHD-D' : 'MNK-D');
    const productId = this.items?.[0]?.productId;
    const categoryNumber = await getCategoryNumberForProduct(productId);
    this.orderNumber = await allocateOrderNumber({
      ref,
      categoryNumber,
      source: this.source,
    });
  }
});

OrderSchema.pre('save', function () {
  if (this.isNew || this.isModified('status')) {
    this.statusUpdateTime = new Date();
  }

  this.paymentType = inferPaymentType(this);
  this.isPartialPayment = this.paymentType !== 'full';

  const { totalPaid, remainingAmount } = calculateOrderFinancials(this);
  this.paidAmount = totalPaid;
  this.remainingAmount = remainingAmount;

  const normalizedIp =
    normalizeIp(this.latestClientIp || this.paymentAttempts?.[0]?.ip) ||
    undefined;
  const normalizedFingerprint = normalizeEmail(this.deviceFingerprint);

  if (normalizedIp) this.latestClientIp = normalizedIp;
  if (normalizedFingerprint) this.deviceFingerprint = normalizedFingerprint;
});

OrderSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const update = this.getUpdate() as Record<string, unknown> | undefined;
  touchStatusUpdateTime(update);
});

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ statusUpdateTime: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ status: 1, statusUpdateTime: -1 });
OrderSchema.index({ source: 1, status: 1, createdAt: -1 });
OrderSchema.index({ source: 1, status: 1, statusUpdateTime: -1 });
OrderSchema.index({ 'billingData.email': 1, source: 1 });
OrderSchema.index({ source: 1, status: 1, paymentType: 1, createdAt: -1 });
OrderSchema.index({
  source: 1,
  status: 1,
  paymentType: 1,
  latestClientIp: 1,
  createdAt: -1,
});
OrderSchema.index({
  source: 1,
  status: 1,
  paymentType: 1,
  deviceFingerprint: 1,
  createdAt: -1,
});
OrderSchema.index({ source: 1, status: 1, isPartialPayment: 1, createdAt: -1 });
OrderSchema.index({ 'items.productId': 1 });

if (process.env.NODE_ENV !== 'production' && mongoose.models.Order) {
  mongoose.deleteModel('Order');
}

const Order =
  (mongoose.models.Order as mongoose.Model<IOrder>) ||
  mongoose.model<IOrder>('Order', OrderSchema);

export default Order;
