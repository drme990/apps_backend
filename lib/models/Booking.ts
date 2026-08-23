import mongoose from 'mongoose';

export interface PaymentMethodTolerance {
  type: 'percentage' | 'fixnumber';
  value: number;
}

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
   * - `false` → auto-detect from `Africa/Cairo` IANA timezone
   *   (returns UTC+3 in summer, UTC+2 in winter — relies on system
   *   tzdata being up to date)
   *
   * Only set to `true` when the auto-detection is wrong (e.g. system
   * tzdata is outdated and doesn't know about Egypt's latest DST
   * decision). The default (`false`) is the safe choice — it trusts
   * the system timezone database.
   */
  summerTimeEnabled?: boolean;
  /**
   * Payment-method tolerances (payment tolerance / allowRate).
   *
   * A map from payment method name (e.g. "insta_pay") to a tolerance
   * config. When an invoice is confirmed and the payment method has a
   * tolerance, the order can be marked as "paid" even if the invoice
   * value is slightly less than the remaining amount.
   *
   * - `percentage`: order is paid when invoiceValue >= remaining * (1 - value/100)
   * - `fixnumber`:  order is paid when invoiceValue >= remaining - value
   */
  paymentMethodTolerances?: Record<string, PaymentMethodTolerance> | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const PaymentMethodToleranceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['percentage', 'fixnumber'],
      required: true,
    },
    value: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false },
);

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
    paymentMethodTolerances: {
      type: Map,
      of: PaymentMethodToleranceSchema,
      default: {},
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
