import mongoose from 'mongoose';

interface IWebhookEvent {
  provider: 'easykash';
  eventKey: string;
  orderReference: string;
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
  },
  { timestamps: true },
);

WebhookEventSchema.index({ provider: 1, eventKey: 1 }, { unique: true });

const WebhookEvent =
  (mongoose.models.WebhookEvent as mongoose.Model<IWebhookEvent>) ||
  mongoose.model<IWebhookEvent>('WebhookEvent', WebhookEventSchema);

export default WebhookEvent;
