import mongoose from 'mongoose';

export interface ITerminalLog {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  source: 'request' | 'error';
  message?: string;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}

const TerminalLogSchema = new mongoose.Schema<ITerminalLog>(
  {
    ts: { type: String, required: true, index: true },
    level: {
      type: String,
      required: true,
      enum: ['info', 'warn', 'error'],
      index: true,
    },
    event: { type: String, required: true, index: true },
    source: {
      type: String,
      required: true,
      enum: ['request', 'error'],
      index: true,
    },
    message: { type: String },
    payload: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TerminalLogSchema.index({ createdAt: -1 });

if (mongoose.models.TerminalLog) {
  delete mongoose.models.TerminalLog;
}

const TerminalLog = mongoose.model<ITerminalLog>(
  'TerminalLog',
  TerminalLogSchema,
);

export default TerminalLog;
