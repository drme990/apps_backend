import mongoose from 'mongoose';

export type OrderStatus =
  | 'pending'
  | 'processing'
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
  | 'other';

export interface IOrderItem {
  productId: string;
  productSlug?: string;
  productName: { ar: string; en: string };
  price: number;
  currency: string;
  quantity: number;
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

export interface IOrder {
  _id?: string;
  orderNumber: string;
  items: IOrderItem[];
  totalAmount: number;
  currency: string;
  status: OrderStatus;
  paymentMethod?: PaymentMethod;
  billingData: IBillingData;
  easykashRef?: string;
  easykashProductCode?: string;
  easykashVoucher?: string;
  easykashResponse?: Record<string, string | number | undefined>;
  couponCode?: string;
  couponDiscount?: number;
  fullAmount?: number;
  paidAmount?: number;
  remainingAmount?: number;
  isPartialPayment?: boolean;
  sizeIndex?: number;
  referralId?: string;
  termsAgreedAt?: Date;
  reservationData?: IReservationAnswer[];
  source?: 'manasik' | 'ghadaq';
  countryCode?: string;
  locale?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const OrderItemSchema = new mongoose.Schema<IOrderItem>(
  {
    productId: { type: String, required: true },
    productSlug: { type: String, trim: true, lowercase: true },
    productName: {
      ar: { type: String, required: true },
      en: { type: String, required: true },
    },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
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

const OrderSchema = new mongoose.Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
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
        'paid',
        'completed',
        'failed',
        'refunded',
        'cancelled',
      ],
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
      ],
    },
    billingData: { type: BillingDataSchema, required: true },
    easykashRef: { type: String, index: true },
    easykashProductCode: { type: String, index: true },
    easykashVoucher: { type: String },
    easykashResponse: { type: mongoose.Schema.Types.Mixed },
    couponCode: { type: String, trim: true, uppercase: true },
    couponDiscount: { type: Number, min: 0, default: 0 },
    fullAmount: { type: Number, min: 0 },
    paidAmount: { type: Number, min: 0 },
    remainingAmount: { type: Number, min: 0 },
    isPartialPayment: { type: Boolean, default: false },
    sizeIndex: { type: Number, min: 0, default: 0 },
    referralId: { type: String, trim: true, index: true },
    termsAgreedAt: { type: Date },
    reservationData: { type: [ReservationAnswerSchema], default: [] },
    source: {
      type: String,
      enum: ['manasik', 'ghadaq'],
      default: 'manasik',
      index: true,
    },
    countryCode: { type: String, trim: true },
    locale: { type: String, trim: true, default: 'ar' },
  },
  { timestamps: true },
);

// Generate order number before validation
OrderSchema.pre('validate', async function () {
  if (!this.orderNumber) {
    const date = new Date();
    const tag = this.source === 'ghadaq' ? 'GHD' : 'MNK';
    const prefix = `${tag}-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
    const count = await mongoose.models.Order.countDocuments({
      orderNumber: { $regex: `^${prefix}` },
    });
    this.orderNumber = `${prefix}-${String(count + 1).padStart(5, '0')}`;
  }
});

OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });

if (process.env.NODE_ENV !== 'production' && mongoose.models.Order) {
  mongoose.deleteModel('Order');
}

const Order =
  (mongoose.models.Order as mongoose.Model<IOrder>) ||
  mongoose.model<IOrder>('Order', OrderSchema);

export default Order;
