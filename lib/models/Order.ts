import mongoose from 'mongoose';
import OrderSequence from '@/lib/models/OrderSequence';
import Category from '@/lib/models/Categories';
import Booking from '@/lib/models/Booking';
import { calculateOrderFinancials } from '@/lib/services/order-financials';
import { updateOrderExecutionDateOnPaid } from '@/lib/execution-date';
import { getOrderExecutionDate, allocateExecutionNumber } from '@/lib/services/execution-number';

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
  productId?: mongoose.Types.ObjectId | string;
  productSlug?: string;
  productName: { ar: string; en: string };
  price: number;
  originalPrice?: number;
  currency: string;
  quantity: number;
  sizeIndex?: number;
  sizeName?: { ar: string; en: string };
  /** Design-only name snapshot from the product size (for the design app) */
  sizeDesignName?: string;
  isCustom?: boolean;
  customSize?: string;
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
  /** When a payment-method tolerance was used to mark the order as paid,
   * this records the tolerance details so admins can see the difference. */
  allowRateApplied?: {
    type: 'percentage' | 'fixnumber';
    value: number;
    /** The actual invoice value entered by the admin */
    invoiceValue: number;
    /** The remaining amount before this invoice was applied */
    remainingBefore: number;
    /** The difference between remaining and invoice value (covered by tolerance) */
    difference: number;
    /** The payment method whose tolerance was applied */
    paymentMethod?: string;
  } | null;
}

export interface IPaymentAttempt {
  createdAt: Date;
  ip?: string;
  userId?: string;
}

export type InvoiceStatus = 'confirmed' | 'waiting' | 'pending' | 'rejected';

export interface IInvoiceUrl {
  url: string;
  invoiceStatus?: InvoiceStatus;
  rejectionReason?: string;
  value: number;
  currency?: string;
  /**
   * `true` when the invoice was uploaded during manual order creation.
   * These invoices are just attached documents — their amount is NOT
   * recorded as a separate payment (the paid amount comes from the
   * manually-entered `paidAmount` field) and they don't appear in the
   * payment timeline.
   *
   * `false` (default) for invoices uploaded to an existing order via
   * the PATCH route — these ARE recorded as payments and appear in
   * the timeline.
   */
  whileCreating?: boolean;
}

/**
 * A generated design image for an order, one per product that had a
 * matching template. Populated by the design-app callback flow
 * (POST /api/admin/orders/[id]/generate-design).
 */
export interface IOrderDesignUrl {
  /** Backend product ID (string ObjectId) this design was generated for */
  productId: string;
  /** Product name snapshot (for display without a DB lookup) */
  productName?: string;
  /** Public R2 URL of the generated JPG */
  url: string;
  /** Which template variant was used — 'text' (no-image) or 'image' */
  templateType: 'text' | 'image';
  /**
   * ID of the design-app project (design instance) generated for this
   * order. The admin panel opens `{DESIGN_APP_URL}/editor/d/{projectId}`
   * so the admin can edit THIS specific design — not the template.
   * The template stays unchanged; only this design instance is edited.
   */
  projectId?: string;
  /** When the design was generated (UTC) */
  createdAt: Date;
  /**
   * Whether an admin (with `orderDesigns` access) has marked this design
   * as reviewed. Newly generated designs default to `false` ("waiting
   * for review").
   */
  reviewed?: boolean;
  /** When the design was marked as reviewed (UTC) */
  reviewedAt?: Date;
  /** Name/email of the admin who marked it reviewed, for audit purposes */
  reviewedBy?: string;
  /**
   * The currently-active version number for this design (explicit
   * pointer). The history UI marks `version === currentVersion` as
   * "current" — never infer current state from array position.
   *
   * Set to `null` when the design has been deleted (the `admin_delete`
   * event preserves the last snapshot but clears the active pointer).
   * Undefined for legacy entries created before this field was added.
   *
   * See `order-history-enhanced.md` §11.
   */
  currentVersion?: number | null;
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
  paymentMethod?: PaymentMethod;
  isWhatsappButtonClicked?: 'clicked' | 'not-clicked' | 'no-need-to-click';
  referralId?: string;
  cancellationReason?: string;
  invoiceUrls?: IInvoiceUrl[];
  /** Generated design images — one entry per product with a template */
  designUrls?: IOrderDesignUrl[];
  termsAgreedAt?: Date;
  reservationData?: IReservationAnswer[];
  payments?: IPayment[];
  paymentAttempts?: IPaymentAttempt[];
  source?: 'manasik' | 'ghadaq';
  latestClientIp?: string;
  deviceFingerprint?: string;
  locale?: string;
  statusUpdateTime: Date;
  /**
   * Daily execution sequence number. Assigned the first time an order
   * gets an execution date, and re-assigned whenever the execution date
   * changes. Numbers reset to 1 for each execution date.
   */
  executionNumber?: number;
  /**
   * Server-side conversion send tracking — set once after the matching
   * Events API / Conversions API call succeeds. Prevents duplicate
   * server sends when the webhook retries. The order number is used as
   * the event_id on both browser and server, so a repeat send would be
   * deduplicated by the ad platform anyway, but this flag avoids the
   * extra API call entirely.
   */
  fbPurchaseServerSentAt?: Date;
  tiktokPurchaseServerSentAt?: Date;
  /** Internal notes appended by the system or admins */
  internalNotes?: IInternalNote[];
  createdAt?: Date;
  updatedAt?: Date;
  _previousStatus?: OrderStatus;
  _previousExecutionDate?: string;
}

export interface IInternalNote {
  text: string;
  /** Who/what created the note — admin user name or 'system' */
  author: string;
  createdAt: Date;
}

const OrderItemSchema = new mongoose.Schema<IOrderItem>(
  {
    productId: {
      // Mixed type to support both real product ObjectIds and the
      // manual-order placeholder string '__manual_order__'.
      type: mongoose.Schema.Types.Mixed,
      ref: 'Product',
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
    sizeDesignName: { type: String, trim: true, default: '' },
    isCustom: { type: Boolean, default: false },
    customSize: { type: String, trim: true },
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
    value: { type: String, trim: true, default: '' },
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
    allowRateApplied: {
      type: new mongoose.Schema(
        {
          type: {
            type: String,
            enum: ['percentage', 'fixnumber'],
            required: true,
          },
          value: { type: Number, required: true, min: 0 },
          invoiceValue: { type: Number, required: true, min: 0 },
          remainingBefore: { type: Number, required: true, min: 0 },
          difference: { type: Number, required: true },
          paymentMethod: { type: String },
        },
        { _id: false },
      ),
      default: null,
    },
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
    invoiceStatus: {
      type: String,
      enum: ['confirmed', 'waiting', 'pending', 'rejected'],
      default: 'waiting',
    },
    rejectionReason: { type: String, default: '' },
    value: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, trim: true, default: 'EGP' },
    whileCreating: { type: Boolean, default: false },
  },
  { _id: false },
);

const OrderDesignUrlSchema = new mongoose.Schema<IOrderDesignUrl>(
  {
    productId: { type: String, required: true, trim: true },
    productName: { type: String, trim: true },
    url: { type: String, required: true, trim: true },
    templateType: {
      type: String,
      enum: ['text', 'image'],
      required: true,
    },
    projectId: { type: String, trim: true },
    createdAt: { type: Date, required: true, default: () => new Date() },
    reviewed: { type: Boolean, default: false },
    reviewedAt: { type: Date },
    reviewedBy: { type: String, trim: true },
    // Explicit current-version pointer. Null = deleted. Undefined = legacy.
    currentVersion: { type: Number, default: null, sparse: true },
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
    designUrls: { type: [OrderDesignUrlSchema], default: [] },
    statusUpdateTime: {
      type: Date,
      required: true,
      default: () => new Date(),
      index: true,
    },
    executionNumber: {
      type: Number,
      min: 1,
      index: true,
      sparse: true,
    },
    fbPurchaseServerSentAt: { type: Date },
    tiktokPurchaseServerSentAt: { type: Date },
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
    internalNotes: {
      type: [
        new mongoose.Schema(
          {
            text: { type: String, required: true, trim: true },
            author: { type: String, required: true, default: 'system' },
            createdAt: { type: Date, required: true, default: () => new Date() },
          },
          { _id: true, timestamps: false },
        ),
      ],
      default: [],
    },
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

OrderSchema.pre('save', async function () {
  if (this.isNew || this.isModified('status')) {
    this.statusUpdateTime = new Date();
  }

  // Recompute execution date when the order reaches a paid/partial-paid status,
  // using the payment moment and the configured cutoff time. This ensures orders
  // paid after the daily cutoff are pushed to the next available day.
  // We only do this when transitioning from a non-paid status (failed, processing, pending, or new).
  // We do not recompute if changing from partial-paid to paid/completed, or any other transition.
  const NON_PAID_STATUSES = ['pending', 'processing', 'failed'];
  const prevStatus = this._previousStatus;
  const isTransitionFromNonPaid = this.isNew || !prevStatus || NON_PAID_STATUSES.includes(prevStatus);

  const isPaidStatus =
    this.isModified('status') &&
    (this.status === 'paid' || this.status === 'partial-paid') &&
    isTransitionFromNonPaid;

  if (isPaidStatus) {
    const booking = await Booking.findOne({ key: 'global' }).lean();
    if (booking) {
      const updatedExecutionDate = updateOrderExecutionDateOnPaid(this, booking);
      if (updatedExecutionDate) {
        this.markModified('reservationData');
      }
    }
  }

  // Assign / re-assign execution number whenever the execution date changes
  // for a paid/partial-paid order. Numbers are per execution date and only
  // allocated once an order is payable, so the execution table shows a clean
  // 1..N sequence for the active orders of each day.
  // This is a best-effort display convenience: if the counter allocation
  // fails, we still save the order and log the error.
  try {
    const isPaidStatus = this.status === 'paid' || this.status === 'partial-paid';
    if (isPaidStatus) {
      const currentExecutionDate = getOrderExecutionDate(this);
      if (currentExecutionDate) {
        const previousExecutionDate = this._previousExecutionDate;
        const hasExecutionDateChanged =
          !this.executionNumber || currentExecutionDate !== previousExecutionDate;
        if (hasExecutionDateChanged) {
          this.executionNumber = await allocateExecutionNumber(currentExecutionDate);
          this._previousExecutionDate = currentExecutionDate;
        }
      }
    }
  } catch (error) {
    console.error('[Order pre-save] Failed to allocate execution number:', error);
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

OrderSchema.post('init', function (doc) {
  doc._previousStatus = doc.status;
  doc._previousExecutionDate = getOrderExecutionDate(doc) || undefined;
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
