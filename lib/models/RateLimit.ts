import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IRateLimit extends Document {
  identifier: string;
  count: number;
  resetAt: Date;
}

const RateLimitSchema = new Schema<IRateLimit>(
  {
    identifier: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    count: {
      type: Number,
      required: true,
      default: 0,
    },
    resetAt: {
      type: Date,
      required: true,
      // TTL index to automatically delete expired documents
      index: { expires: '0s' },
    },
  },
  {
    timestamps: true,
  },
);

const RateLimit: Model<IRateLimit> =
  mongoose.models.RateLimit ||
  mongoose.model<IRateLimit>('RateLimit', RateLimitSchema);

export default RateLimit;
