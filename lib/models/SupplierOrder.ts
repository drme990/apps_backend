import mongoose from 'mongoose';

export interface ISupplierOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface ISupplierOrder {
  _id?: string;
  supplierId: mongoose.Types.ObjectId | string;
  items: ISupplierOrderItem[];
  totalAmount: number;
  orderDate: Date;
  notes?: string;
  status: 'pending' | 'received' | 'cancelled';
  createdAt?: Date;
  updatedAt?: Date;
}

const SupplierOrderItemSchema = new mongoose.Schema<ISupplierOrderItem>(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const SupplierOrderSchema = new mongoose.Schema<ISupplierOrder>(
  {
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
      index: true,
    },
    items: { type: [SupplierOrderItemSchema], required: true },
    totalAmount: { type: Number, required: true, min: 0, default: 0 },
    orderDate: { type: Date, required: true, default: Date.now },
    notes: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'received', 'cancelled'],
      default: 'pending',
    },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.SupplierOrder) {
  mongoose.deleteModel('SupplierOrder');
}

const SupplierOrder =
  (mongoose.models.SupplierOrder as mongoose.Model<ISupplierOrder>) ||
  mongoose.model<ISupplierOrder>('SupplierOrder', SupplierOrderSchema);

export default SupplierOrder;
