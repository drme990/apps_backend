import mongoose from 'mongoose';

export interface ISupplierPayout {
  _id?: string;
  supplierId: mongoose.Types.ObjectId | string;
  amount: number;
  accountId?: mongoose.Types.ObjectId | string | null;
  date: Date;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const SupplierPayoutSchema = new mongoose.Schema<ISupplierPayout>(
  {
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      default: null,
    },
    date: { type: Date, required: true, default: Date.now },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.SupplierPayout) {
  mongoose.deleteModel('SupplierPayout');
}

const SupplierPayout =
  (mongoose.models.SupplierPayout as mongoose.Model<ISupplierPayout>) ||
  mongoose.model<ISupplierPayout>('SupplierPayout', SupplierPayoutSchema);

export default SupplierPayout;
