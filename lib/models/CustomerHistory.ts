import mongoose from 'mongoose';

export interface ICustomerHistory {
  _id?: string;
  customerId: string;
  appId: 'ghadaq' | 'manasik';
  customerName?: string;
  customerEmail?: string;
  type: 'ref' | 'country';
  previousValue: string | null;
  newValue: string | null;
  changeSource: 'single' | 'bulk' | null;
  changedByUserId: string;
  changedByUserName: string;
  changedByUserEmail: string;
  createdAt?: Date;
}

const CustomerHistorySchema = new mongoose.Schema<ICustomerHistory>(
  {
    customerId: { type: String, required: true, index: true },
    appId: {
      type: String,
      required: true,
      enum: ['ghadaq', 'manasik'],
      index: true,
    },
    customerName: { type: String, trim: true },
    customerEmail: { type: String, trim: true, lowercase: true },
    type: {
      type: String,
      required: true,
      enum: ['ref', 'country'],
      index: true,
    },
    previousValue: { type: String, default: null, trim: true },
    newValue: { type: String, default: null, trim: true },
    changeSource: {
      type: String,
      enum: ['single', 'bulk'],
      default: null,
      index: true,
    },
    changedByUserId: { type: String, required: true, index: true },
    changedByUserName: { type: String, required: true },
    changedByUserEmail: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CustomerHistorySchema.index({ customerId: 1, type: 1, createdAt: -1 });
CustomerHistorySchema.index({ appId: 1, type: 1, createdAt: -1 });
CustomerHistorySchema.index({ type: 1, createdAt: -1 });

const CustomerHistory =
  (mongoose.models.CustomerHistory as mongoose.Model<ICustomerHistory>) ||
  mongoose.model<ICustomerHistory>('CustomerHistory', CustomerHistorySchema);

export default CustomerHistory;
