import mongoose from 'mongoose';

export interface IPaymentLink {
  _id?: string;
  kind: 'order' | 'custom';
  tokenHash: string;
  orderId?: string;
  orderNumber?: string;
  source: 'manasik' | 'ghadaq';
  amountRequested: number;
  currencyCode: string;
  isCustomAmount: boolean;
  usedAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  deletedBy?: {
    userId: string;
    userName: string;
    userEmail: string;
  };
  expiresAt: Date;
  createdBy: {
    userId: string;
    userName: string;
    userEmail: string;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

const PaymentLinkSchema = new mongoose.Schema<IPaymentLink>(
  {
    kind: {
      type: String,
      enum: ['order', 'custom'],
      required: true,
      default: 'order',
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true, index: true },
    orderId: { type: String, index: true },
    orderNumber: { type: String, index: true },
    source: {
      type: String,
      enum: ['manasik', 'ghadaq'],
      default: 'manasik',
      index: true,
    },
    amountRequested: { type: Number, required: true, min: 0.01 },
    currencyCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    isCustomAmount: { type: Boolean, default: false },
    usedAt: { type: Date },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    deletedBy: {
      userId: { type: String },
      userName: { type: String },
      userEmail: { type: String },
    },
    expiresAt: { type: Date, required: true, index: true },
    createdBy: {
      userId: { type: String, required: true },
      userName: { type: String, required: true },
      userEmail: { type: String, required: true },
    },
  },
  { timestamps: true },
);

PaymentLinkSchema.index({ orderId: 1, expiresAt: -1 });
PaymentLinkSchema.index({ kind: 1, source: 1, expiresAt: -1 });
PaymentLinkSchema.index({ usedAt: -1, createdAt: -1 });
PaymentLinkSchema.index({ isDeleted: 1, createdAt: -1 });

if (process.env.NODE_ENV !== 'production' && mongoose.models.PaymentLink) {
  mongoose.deleteModel('PaymentLink');
}

const PaymentLink =
  (mongoose.models.PaymentLink as mongoose.Model<IPaymentLink>) ||
  mongoose.model<IPaymentLink>('PaymentLink', PaymentLinkSchema);

export default PaymentLink;
