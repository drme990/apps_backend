import mongoose from 'mongoose';

export interface IBooking {
  _id?: string;
  key: 'global';
  blockedExecutionDates: string[];
  cutoffTime: string | null;
  lastDayEndAt: string | null;
  defaultExecutionDate: string | null;
  prevDay: string | null;
  /**
   * Manual override for Egypt Daylight Saving Time (التوقيت الصيفي).
   *
   * - `true`  → force UTC+3 (summer time active)
   * - `false` → force UTC+2 (standard time)
   *
   * When set, all Egypt time calculations in execution-date.ts use the
   * fixed offset instead of the `Africa/Cairo` IANA timezone. This gives
   * the admin manual control when Egypt's DST schedule changes
   * unpredictably (which it does — the government announces it
   * year-by-year, sometimes at short notice).
   */
  summerTimeEnabled?: boolean;
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
    cutoffTime: {
      type: String,
      default: null,
    },
    lastDayEndAt: {
      type: String,
      default: null,
    },
    defaultExecutionDate: {
      type: String,
      default: null,
    },
    prevDay: {
      type: String,
      default: null,
    },
    summerTimeEnabled: {
      type: Boolean,
      default: false,
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
