import mongoose from 'mongoose';

export interface IBooking {
  _id?: string;
  key: 'global';
  blockedExecutionDates: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

const BookingSchema = new mongoose.Schema<IBooking>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'global',
      enum: ['global'],
    },
    blockedExecutionDates: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.Booking) {
  mongoose.deleteModel('Booking');
}

const Booking =
  (mongoose.models.Booking as mongoose.Model<IBooking>) ||
  mongoose.model<IBooking>('Booking', BookingSchema);

export default Booking;
