import mongoose from 'mongoose';

export interface IActivityLog {
  _id?: string;
  userId: string;
  userName: string;
  userEmail: string;
  action: 'create' | 'update' | 'delete' | 'login' | 'logout';
  resource:
    | 'product'
    | 'user'
    | 'auth'
    | 'country'
    | 'order'
    | 'coupon'
    | 'referral'
    | 'appearance'
    | 'upload';
  resourceId?: string;
  details: string;
  metadata?: mongoose.Schema.Types.Mixed;
  createdAt?: Date;
}

const ActivityLogSchema = new mongoose.Schema<IActivityLog>(
  {
    userId: {
      type: String,
      required: [true, 'User ID is required'],
      index: true,
    },
    userName: { type: String, required: [true, 'User name is required'] },
    userEmail: { type: String, required: [true, 'User email is required'] },
    action: {
      type: String,
      required: [true, 'Action is required'],
      enum: ['create', 'update', 'delete', 'login', 'logout'],
      index: true,
    },
    resource: {
      type: String,
      required: [true, 'Resource is required'],
      enum: [
        'product',
        'user',
        'auth',
        'country',
        'order',
        'coupon',
        'referral',
        'appearance',
      ],
      index: true,
    },
    resourceId: { type: String },
    details: { type: String, required: [true, 'Details are required'] },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ActivityLogSchema.index({ createdAt: -1 });
ActivityLogSchema.index({ userId: 1, createdAt: -1 });

if (mongoose.models.ActivityLog) {
  delete mongoose.models.ActivityLog;
}

const ActivityLog = mongoose.model<IActivityLog>(
  'ActivityLog',
  ActivityLogSchema,
);

export default ActivityLog;
