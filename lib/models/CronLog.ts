import mongoose from 'mongoose';

export interface ICronLog {
  _id?: string;
  jobName: string;
  status: 'success' | 'failed';
  totalProducts: number;
  updatedCount: number;
  targetCurrencies: string[];
  errorMessage?: string;
  duration: number;
  createdAt?: Date;
}

const CronLogSchema = new mongoose.Schema<ICronLog>(
  {
    jobName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['success', 'failed'],
    },
    totalProducts: { type: Number, default: 0 },
    updatedCount: { type: Number, default: 0 },
    targetCurrencies: [{ type: String, uppercase: true }],
    errorMessage: { type: String },
    duration: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const CronLog =
  (mongoose.models.CronLog as mongoose.Model<ICronLog>) ||
  mongoose.model<ICronLog>('CronLog', CronLogSchema);

export default CronLog;
