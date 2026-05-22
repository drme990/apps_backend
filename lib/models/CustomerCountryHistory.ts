import mongoose from 'mongoose';

export interface ICustomerCountryHistory {
  _id?: string;
  customerId: string;
  appId: 'ghadaq' | 'manasik';
  customerName?: string;
  customerEmail?: string;
  previousCountry: string | null;
  newCountry: string | null;
  changedByUserId: string;
  changedByUserName: string;
  changedByUserEmail: string;
  createdAt?: Date;
}

const CustomerCountryHistorySchema = new mongoose.Schema<ICustomerCountryHistory>(
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
    previousCountry: { type: String, default: null, trim: true },
    newCountry: { type: String, default: null, trim: true },
    changedByUserId: { type: String, required: true, index: true },
    changedByUserName: { type: String, required: true },
    changedByUserEmail: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

CustomerCountryHistorySchema.index({ customerId: 1, createdAt: -1 });
CustomerCountryHistorySchema.index({ appId: 1, createdAt: -1 });

const CustomerCountryHistory =
  (mongoose.models.CustomerCountryHistory as mongoose.Model<ICustomerCountryHistory>) ||
  mongoose.model<ICustomerCountryHistory>(
    'CustomerCountryHistory',
    CustomerCountryHistorySchema,
  );

export default CustomerCountryHistory;
