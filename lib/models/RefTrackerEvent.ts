import mongoose from 'mongoose';

export type RefTrackerAppId = 'manasik' | 'ghadaq';
export type RefTrackerAction =
  | 'session_created'
  | 'navigate_products'
  | 'select_product'
  | 'pay_now'
  | 'checkout_choice'
  | 'proceed_to_payment';

export interface IRefTrackerEvent {
  _id?: string;
  appId: RefTrackerAppId;
  sessionNumber: string;
  userId?: string;
  ref?: string;
  ip?: string;
  action: RefTrackerAction;
  path: string;
  productName?: string;
  buttonLabel?: string;
  choice?: string;
  metadata?: mongoose.Schema.Types.Mixed;
  createdAt?: Date;
  updatedAt?: Date;
}

const RefTrackerEventSchema = new mongoose.Schema<IRefTrackerEvent>(
  {
    appId: {
      type: String,
      required: true,
      enum: ['manasik', 'ghadaq'],
      index: true,
    },
    sessionNumber: { type: String, required: true, index: true },
    userId: { type: String, trim: true, index: true },
    ref: { type: String, trim: true, index: true },
    ip: { type: String, trim: true, index: true },
    action: {
      type: String,
      required: true,
      enum: [
        'session_created',
        'navigate_products',
        'select_product',
        'pay_now',
        'checkout_choice',
        'proceed_to_payment',
      ],
      index: true,
    },
    path: { type: String, required: true, trim: true },
    productName: { type: String, trim: true },
    buttonLabel: { type: String, trim: true },
    choice: { type: String, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true, collection: 'ref_tracker_events' },
);

RefTrackerEventSchema.index({ createdAt: -1 });
RefTrackerEventSchema.index({ appId: 1, createdAt: -1 });
RefTrackerEventSchema.index({ sessionNumber: 1, createdAt: -1 });

if (mongoose.models.RefTrackerEvent) {
  delete mongoose.models.RefTrackerEvent;
}

const RefTrackerEvent = mongoose.model<IRefTrackerEvent>(
  'RefTrackerEvent',
  RefTrackerEventSchema,
);

export default RefTrackerEvent;
