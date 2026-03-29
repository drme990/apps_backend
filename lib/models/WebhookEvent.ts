import mongoose from 'mongoose';

interface IWebhookEvent {
  provider: 'easykash';
  eventKey: string;
  orderReference: string;
  status: 'processed' | 'failed' | 'dead_letter';
  payload?: Record<string, unknown>;
  errorReason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const WebhookEventSchema = new mongoose.Schema<IWebhookEvent>(
  {
    provider: {
      type: String,
      enum: ['easykash'],
      required: true,
      index: true,
    },
    eventKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    orderReference: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['processed', 'failed', 'dead_letter'],
      default: 'processed',
      index: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
    },
    errorReason: {
      type: String,
    },
  },
  { timestamps: true },
);

WebhookEventSchema.index({ provider: 1, eventKey: 1 }, { unique: true });

const WebhookEvent =
  (mongoose.models.WebhookEvent as mongoose.Model<IWebhookEvent>) ||
  mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);

export default WebhookEvent;
