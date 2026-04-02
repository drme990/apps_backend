import mongoose from 'mongoose';

interface IOrderSequence {
  _id: string;
  seq: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const OrderSequenceSchema = new mongoose.Schema<IOrderSequence>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.OrderSequence) {
  mongoose.deleteModel('OrderSequence');
}

const OrderSequence =
  (mongoose.models.OrderSequence as mongoose.Model<IOrderSequence>) ||
  mongoose.model<IOrderSequence>('OrderSequence', OrderSequenceSchema);

export default OrderSequence;
