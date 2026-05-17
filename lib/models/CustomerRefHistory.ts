import mongoose from 'mongoose';

export interface ICustomerRefHistory {
  _id?: string;
  customerId: string;
  appId: 'ghadaq' | 'manasik';
  customerName?: string;
  customerEmail?: string;
  previousRef: string | null;
  newRef: string | null;
  changedByUserId: string;
  changedByUserName: string;
  changedByUserEmail: string;
  changeSource: 'single' | 'bulk';
  createdAt?: Date;
}

const CustomerRefHistorySchema = new mongoose.Schema<ICustomerRefHistory>(
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
    previousRef: { type: String, default: null, trim: true },
    newRef: { type: String, default: null, trim: true },
    changedByUserId: { type: String, required: true, index: true },
    changedByUserName: { type: String, required: true },
    changedByUserEmail: { type: String, required: true },
    changeSource: {
      type: String,
      required: true,
      enum: ['single', 'bulk'],
      default: 'single',
      index: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CustomerRefHistorySchema.index({ customerId: 1, createdAt: -1 });
CustomerRefHistorySchema.index({ appId: 1, createdAt: -1 });

const CustomerRefHistory =
  (mongoose.models.CustomerRefHistory as mongoose.Model<ICustomerRefHistory>) ||
  mongoose.model<ICustomerRefHistory>(
    'CustomerRefHistory',
    CustomerRefHistorySchema,
  );

export default CustomerRefHistory;
