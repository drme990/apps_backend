import mongoose from 'mongoose';

export interface ISupplier {
  _id?: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  balance: number;
  totalOrders: number;
  totalPayouts: number;
  status: 'active' | 'inactive';
  createdAt?: Date;
  updatedAt?: Date;
}

const SupplierSchema = new mongoose.Schema<ISupplier>(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    balance: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    totalPayouts: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.Supplier) {
  mongoose.deleteModel('Supplier');
}

const Supplier =
  (mongoose.models.Supplier as mongoose.Model<ISupplier>) ||
  mongoose.model<ISupplier>('Supplier', SupplierSchema);

export default Supplier;
