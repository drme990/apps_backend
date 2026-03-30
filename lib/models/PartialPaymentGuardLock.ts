import mongoose from 'mongoose';

export interface IPartialPaymentGuardLock {
  key: string;
  source: 'manasik' | 'ghadaq';
  ownerToken: string;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const PartialPaymentGuardLockSchema =
  new mongoose.Schema<IPartialPaymentGuardLock>(
    {
      key: { type: String, required: true, unique: true, index: true },
      source: {
        type: String,
        enum: ['manasik', 'ghadaq'],
        required: true,
        index: true,
      },
      ownerToken: { type: String, required: true, index: true },
      expiresAt: {
        type: Date,
        required: true,
        index: { expires: '0s' },
      },
    },
    { timestamps: true },
  );

if (
  process.env.NODE_ENV !== 'production' &&
  mongoose.models.PartialPaymentGuardLock
) {
  mongoose.deleteModel('PartialPaymentGuardLock');
}

const PartialPaymentGuardLock =
  (mongoose.models
    .PartialPaymentGuardLock as mongoose.Model<IPartialPaymentGuardLock>) ||
  mongoose.model<IPartialPaymentGuardLock>(
    'PartialPaymentGuardLock',
    PartialPaymentGuardLockSchema,
  );

export default PartialPaymentGuardLock;
