import mongoose from 'mongoose';

export interface IPaymentLink {
  _id?: string;
  kind: 'order' | 'custom';
  status: 'unused' | 'opened' | 'used';
  publicToken: string;
  tokenHash: string;
  orderId?: mongoose.Types.ObjectId | string;
  orderNumber?: string;
  source: 'manasik' | 'ghadaq';
  amountRequested: number;
  currencyCode: string;
  isCustomAmount: boolean;
  openedAt?: Date;
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
    status: {
      type: String,
      enum: ['unused', 'opened', 'used'],
      required: true,
      default: 'unused',
      index: true,
    },
    publicToken: { type: String, required: true, unique: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      index: true,
    },
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
    openedAt: { type: Date },
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
PaymentLinkSchema.index({ status: 1, expiresAt: -1, createdAt: -1 });
PaymentLinkSchema.index({ isDeleted: 1, createdAt: -1 });

if (process.env.NODE_ENV !== 'production' && mongoose.models.PaymentLink) {
  mongoose.deleteModel('PaymentLink');
}

const PaymentLink =
  (mongoose.models.PaymentLink as mongoose.Model<IPaymentLink>) ||
  mongoose.model<IPaymentLink>('PaymentLink', PaymentLinkSchema);

export default PaymentLink;
