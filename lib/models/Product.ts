import mongoose from 'mongoose';

export interface ICurrencyPrice {
  currencyCode: string;
  amount: number;
  isManual: boolean;
}

export interface ICurrencyMinimumPayment {
  currencyCode: string;
  value: number;
  isManual: boolean;
}

export interface IProductSize {
  _id?: string;
  name: { ar: string; en: string };
  price: number;
  prices: ICurrencyPrice[];
  feedsUp?: number;
}

export interface IPartialPayment {
  isAllowed: boolean;
  minimumType: 'percentage' | 'fixed';
  minimumPayments: ICurrencyMinimumPayment[];
}

export interface IReservationField {
  type: 'text' | 'textarea' | 'number' | 'date' | 'select' | 'picture';
  label: { ar: string; en: string };
  required: boolean;
  maxLength?: number;
  options?: { ar: string; en: string }[];
}

export interface IProduct {
  _id?: string;
  name: { ar: string; en: string };
  slug?: string;
  content?: { ar: string; en: string };
  baseCurrency: string;
  inStock: boolean;
  isActive: boolean;
  images: string[];
  sizes: IProductSize[];
  partialPayment: IPartialPayment;
  upgradeTo?: string;
  upgradeDiscount?: number;
  workAsSacrifice?: boolean;
  sacrificeCount?: number;
  reservationFields?: IReservationField[];
  displayOrder?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const CurrencyPriceSchema = new mongoose.Schema(
  {
    currencyCode: { type: String, required: true, uppercase: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    isManual: { type: Boolean, default: false },
  },
  { _id: false },
);

const ProductSizeSchema = new mongoose.Schema({
  name: {
    ar: { type: String, required: true, trim: true },
    en: { type: String, required: true, trim: true },
  },
  price: { type: Number, required: true, min: 0, default: 0 },
  prices: [CurrencyPriceSchema],
  feedsUp: { type: Number, min: 0, default: 0 },
});

const PartialPaymentSchema = new mongoose.Schema(
  {
    isAllowed: { type: Boolean, default: false },
    minimumType: {
      type: String,
      enum: ['percentage', 'fixed'],
      default: 'percentage',
    },
    minimumPayments: [
      {
        currencyCode: {
          type: String,
          required: true,
          uppercase: true,
          trim: true,
        },
        value: { type: Number, required: true, min: 0 },
        isManual: { type: Boolean, default: false },
        _id: false,
      },
    ],
  },
  { _id: false },
);

const ReservationFieldSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['text', 'textarea', 'number', 'date', 'select', 'picture'],
      required: true,
    },
    label: {
      ar: { type: String, required: true, trim: true },
      en: { type: String, required: true, trim: true },
    },
    required: { type: Boolean, default: false },
    maxLength: { type: Number, min: 1 },
    options: [
      {
        ar: { type: String, required: true, trim: true },
        en: { type: String, required: true, trim: true },
        _id: false,
      },
    ],
  },
  { _id: false },
);

const ProductSchema = new mongoose.Schema<IProduct>(
  {
    name: {
      ar: {
        type: String,
        required: [true, 'Arabic product name is required'],
        trim: true,
        maxlength: [100, 'Arabic product name cannot exceed 100 characters'],
      },
      en: {
        type: String,
        required: [true, 'English product name is required'],
        trim: true,
        maxlength: [100, 'English product name cannot exceed 100 characters'],
      },
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      index: true,
    },
    content: {
      ar: { type: String, trim: true, default: '' },
      en: { type: String, trim: true, default: '' },
    },
    baseCurrency: {
      type: String,
      required: [true, 'Base currency is required'],
      default: 'SAR',
      uppercase: true,
      trim: true,
    },
    inStock: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    images: [{ type: String, trim: true }],
    sizes: {
      type: [ProductSizeSchema],
      validate: {
        validator: (v: unknown[]) => v.length >= 1,
        message: 'Product must have at least one size',
      },
    },
    partialPayment: { type: PartialPaymentSchema, default: () => ({}) },
    upgradeTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
    upgradeDiscount: { type: Number, default: 0, min: 0, max: 100 },
    workAsSacrifice: { type: Boolean, default: false },
    sacrificeCount: { type: Number, default: 1, min: 1 },
    reservationFields: { type: [ReservationFieldSchema], default: [] },
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.Product) {
  mongoose.deleteModel('Product');
}

const Product =
  (mongoose.models.Product as mongoose.Model<IProduct>) ||
  mongoose.model<IProduct>('Product', ProductSchema);

export default Product;
