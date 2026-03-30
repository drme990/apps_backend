import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IPasswordResetThrottle extends Document {
  identifier: string;
  attempts: number;
  nextAllowedAt?: Date;
  bannedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PasswordResetThrottleSchema = new Schema<IPasswordResetThrottle>(
  {
    identifier: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    attempts: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    nextAllowedAt: {
      type: Date,
      default: null,
    },
    bannedUntil: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

const PasswordResetThrottle: Model<IPasswordResetThrottle> =
  mongoose.models.PasswordResetThrottle ||
  mongoose.model<IPasswordResetThrottle>(
    'PasswordResetThrottle',
    PasswordResetThrottleSchema,
  );

export default PasswordResetThrottle;
