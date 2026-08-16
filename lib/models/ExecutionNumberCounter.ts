import mongoose from 'mongoose';

export interface IExecutionNumberCounter {
  _id: string;
  /** Next sequence number to allocate for this execution date */
  seq: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const ExecutionNumberCounterSchema = new mongoose.Schema<IExecutionNumberCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.ExecutionNumberCounter) {
  mongoose.deleteModel('ExecutionNumberCounter');
}

const ExecutionNumberCounter =
  (mongoose.models.ExecutionNumberCounter as mongoose.Model<IExecutionNumberCounter>) ||
  mongoose.model<IExecutionNumberCounter>('ExecutionNumberCounter', ExecutionNumberCounterSchema);

export default ExecutionNumberCounter;
