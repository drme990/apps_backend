import mongoose from 'mongoose';

export interface ITierMinimumAmount {
  currencyCode: string;
  amount: number;
  isManual: boolean;
}

export interface IUserTier {
  _id?: string;
  name: string;
  color: string;
  minimumAmounts: ITierMinimumAmount[];
  mainCurrency: string;
  baseAmount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const TierMinimumAmountSchema = new mongoose.Schema<ITierMinimumAmount>(
  {
    currencyCode: { type: String, required: true, trim: true, uppercase: true },
    amount: { type: Number, required: true, min: 0 },
    isManual: { type: Boolean, default: false },
  },
  { _id: false },
);

const UserTierSchema = new mongoose.Schema<IUserTier>(
  {
    name: { type: String, required: true, trim: true },
    color: { type: String, trim: true, default: '#6366f1' },
    minimumAmounts: { type: [TierMinimumAmountSchema], default: [] },
    mainCurrency: { type: String, required: true, trim: true, uppercase: true },
    baseAmount: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

UserTierSchema.index({ baseAmount: 1 });

const UserTier =
  (mongoose.models.UserTier as mongoose.Model<IUserTier>) ||
  mongoose.model<IUserTier>('UserTier', UserTierSchema);

export default UserTier;
