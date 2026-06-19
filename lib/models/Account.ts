import mongoose from 'mongoose';

export type AccountType =
  | 'bank_account'
  | 'digital_wallet'
  | 'online_bank'
  | 'cash'
  | 'credit_card'
  | 'other';

export interface IAccount {
  _id?: string;
  name: string;
  type: AccountType;
  currency: string;
  openingBalance: number;
  balance: number;
  notes?: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const AccountSchema = new mongoose.Schema<IAccount>(
  {
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ['bank_account', 'digital_wallet', 'online_bank', 'cash', 'credit_card', 'other'],
    },
    currency: { type: String, required: true, trim: true, uppercase: true },
    openingBalance: { type: Number, required: true, default: 0 },
    balance: { type: Number, required: true, default: 0 },
    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

AccountSchema.index({ name: 1 });
AccountSchema.index({ type: 1 });
AccountSchema.index({ isActive: 1 });

const Account =
  (mongoose.models.Account as mongoose.Model<IAccount>) ||
  mongoose.model<IAccount>('Account', AccountSchema);

export default Account;
