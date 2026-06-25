import mongoose from 'mongoose';

export interface IOrderChangeHistory {
  _id?: string;
  orderId: string;
  appId: 'ghadaq' | 'manasik';
  changeType:
  | 'name'
  | 'items'
  | 'duaa'
  | 'photo'
  | 'invoice'
  | 'executionDate'
  | 'bulk_execution_date'
  | 'gender'
  | 'isAlive'
  | 'intention';
  previousValue: string | null;
  newValue: string | null;
  changedByUserId: string;
  changedByUserName: string;
  changedByUserEmail: string;
  createdAt?: Date;
}

const OrderChangeHistorySchema = new mongoose.Schema<IOrderChangeHistory>(
  {
    orderId: { type: String, required: true, index: true },
    appId: {
      type: String,
      required: true,
      enum: ['ghadaq', 'manasik'],
      index: true,
    },
    changeType: {
      type: String,
      required: true,
      enum: [
        'name',
        'items',
        'duaa',
        'photo',
        'invoice',
        'executionDate',
        'bulk_execution_date',
        'gender',
        'isAlive',
        'intention',
      ],
      index: true,
    },
    previousValue: { type: String, default: null },
    newValue: { type: String, default: null },
    changedByUserId: { type: String, required: true, index: true },
    changedByUserName: { type: String, required: true },
    changedByUserEmail: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

OrderChangeHistorySchema.index({ orderId: 1, createdAt: -1 });
OrderChangeHistorySchema.index({ appId: 1, createdAt: -1 });
OrderChangeHistorySchema.index({ changeType: 1, createdAt: -1 });

const OrderChangeHistory =
  (mongoose.models.OrderChangeHistory as mongoose.Model<IOrderChangeHistory>) ||
  mongoose.model<IOrderChangeHistory>(
    'OrderChangeHistory',
    OrderChangeHistorySchema,
  );

export default OrderChangeHistory;
