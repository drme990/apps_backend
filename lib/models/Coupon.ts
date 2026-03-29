import mongoose from 'mongoose';

export type CouponType = 'percentage' | 'fixed';
export type CouponStatus = 'active' | 'expired' | 'disabled';

export interface ICoupon {
  _id?: string;
  code: string;
  type: CouponType;
  value: number;
  currency?: string;
  maxUses?: number;
  usedCount: number;
  maxUsesPerUser?: number;
  validFrom: Date;
  validUntil?: Date;
  status: CouponStatus;
  minOrderAmount?: number;
  maxDiscountAmount?: number;
  applicableProducts?: string[];
  description?: { ar: string; en: string };
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const CouponSchema = new mongoose.Schema<ICoupon>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    type: { type: String, enum: ['percentage', 'fixed'], required: true },
    value: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'SAR' },
    maxUses: { type: Number, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    maxUsesPerUser: { type: Number, min: 1 },
    validFrom: { type: Date, required: true, default: Date.now },
    validUntil: { type: Date },
    status: {
      type: String,
      enum: ['active', 'expired', 'disabled'],
      default: 'active',
    },
    minOrderAmount: { type: Number, min: 0 },
    maxDiscountAmount: { type: Number, min: 0 },
    applicableProducts: [{ type: String }],
    description: {
      ar: { type: String },
      en: { type: String },
    },
    createdBy: { type: String },
  },
  { timestamps: true },
);

CouponSchema.index({ code: 1, status: 1 });
CouponSchema.index({ validUntil: 1, status: 1 });
CouponSchema.index({ code: 1, status: 1, validUntil: 1 });

const Coupon =
  (mongoose.models.Coupon as mongoose.Model<ICoupon>) ||
  mongoose.model<ICoupon>('Coupon', CouponSchema);

export default Coupon;
