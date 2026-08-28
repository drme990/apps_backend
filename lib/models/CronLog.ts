import mongoose from 'mongoose';

/**
 * A single price change recorded during an exchange-rate update run.
 * One entry per (product, size, currency) that was evaluated.
 */
export interface IPriceChange {
  /** Product ObjectId as string */
  productId: string;
  /** Product name (Arabic) for display */
  productNameAr: string;
  /** Product name (English) for display */
  productNameEn: string;
  /** Size name (Arabic) for display */
  sizeNameAr: string;
  /** Size name (English) for display */
  sizeNameEn: string;
  /** Currency code, e.g. "SAR", "EGP" */
  currencyCode: string;
  /** Previous amount (before this run). 0 if the entry didn't exist. */
  prevValue: number;
  /** New amount (after this run). Same as prevValue if not changed. */
  newValue: number;
  /** Whether the value actually changed (prevValue !== newValue) */
  changed: boolean;
  /** Whether this entry is a manual override (skipped) */
  isManual: boolean;
}

export interface ICronLog {
  _id?: string;
  jobName: string;
  status: 'success' | 'failed';
  source: 'cron' | 'manual';
  totalProducts: number;
  updatedCount: number;
  totalCoupons?: number;
  updatedCouponCount?: number;
  targetCurrencies: string[];
  errorMessage?: string;
  duration: number;
  /**
   * Per-(product, size, currency) price changes recorded during this run.
   * Only populated for 'update-prices' job runs. May be large — the API
   * can paginate or limit this if needed.
   */
  priceChanges?: IPriceChange[];
  createdAt?: Date;
}

const PriceChangeSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    productNameAr: { type: String, required: true },
    productNameEn: { type: String, required: true },
    sizeNameAr: { type: String, required: true },
    sizeNameEn: { type: String, required: true },
    currencyCode: { type: String, required: true, uppercase: true },
    prevValue: { type: Number, required: true, default: 0 },
    newValue: { type: Number, required: true, default: 0 },
    changed: { type: Boolean, required: true, default: false },
    isManual: { type: Boolean, default: false },
  },
  { _id: false },
);

const CronLogSchema = new mongoose.Schema<ICronLog>(
  {
    jobName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['success', 'failed'],
    },
    source: {
      type: String,
      required: true,
      enum: ['cron', 'manual'],
      default: 'cron',
    },
    totalProducts: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    targetCurrencies: [{ type: String, uppercase: true }],
    errorMessage: { type: String },
    duration: { type: Number, default: 0 },
    priceChanges: [PriceChangeSchema],
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const CronLog =
  (mongoose.models.CronLog as mongoose.Model<ICronLog>) ||
  mongoose.model<ICronLog>('CronLog', CronLogSchema);

export default CronLog;
