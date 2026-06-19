import mongoose from 'mongoose';

export type TransactionSource =
  | 'supplier'
  | 'customer'
  | 'expense'
  | 'income'
  | 'transfer'
  | 'other';

export type TransactionType = 'debit' | 'credit';

export interface ITransaction {
  _id?: string;
  source: TransactionSource;
  sourceId: mongoose.Types.ObjectId | string;
  accountId: mongoose.Types.ObjectId | string;
  type: TransactionType;
  amount: number;
  date: Date;
  paymentMethod?: string;
  referenceNumber?: string;
  linkedOrderId?: mongoose.Types.ObjectId | string | null;
  notes?: string;
  attachment?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const TransactionSchema = new mongoose.Schema<ITransaction>(
  {
    source: {
      type: String,
      required: true,
      enum: ['supplier', 'customer', 'expense', 'income', 'transfer', 'other'],
      index: true,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['debit', 'credit'],
    },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true, default: Date.now },
    paymentMethod: { type: String, trim: true },
    referenceNumber: { type: String, trim: true },
    linkedOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupplierOrder',
      default: null,
    },
    notes: { type: String, trim: true },
    attachment: { type: String, trim: true },
  },
  { timestamps: true },
);

TransactionSchema.index({ source: 1, sourceId: 1, date: -1 });
TransactionSchema.index({ accountId: 1, date: -1 });

if (process.env.NODE_ENV !== 'production' && mongoose.models.Transaction) {
  mongoose.deleteModel('Transaction');
}

const Transaction =
  (mongoose.models.Transaction as mongoose.Model<ITransaction>) ||
  mongoose.model<ITransaction>('Transaction', TransactionSchema);

export default Transaction;
