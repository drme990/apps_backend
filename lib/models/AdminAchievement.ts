import mongoose from 'mongoose';

/**
 * AdminAchievement — one record per (admin, customer) tracking the
 * booking-intent conversation. See Booking-intent.md.
 *
 * Created when an admin clicks WhatsApp on a booking-intent row (the
 * click IS the claim). Flips to 'paid' when the customer gets any
 * paid-like order — the talking admin gets the conversion point.
 *
 * `customerKey` uses the same identity the booking-intent list groups
 * by: userId → billingData.email → billingData.phone → order _id.
 */
export interface IAdminAchievement {
  _id?: string;
  adminId: mongoose.Types.ObjectId;
  adminName: string;
  adminEmail: string;
  /** userId | billing email | billing phone | order _id — list grouping key. */
  customerKey: string;
  status: 'talking' | 'paid';
  /** Order being discussed; overwritten by the paid order on conversion. */
  orderId?: mongoose.Types.ObjectId;
  claimedAt: Date;
  paidAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const AdminAchievementSchema = new mongoose.Schema<IAdminAchievement>(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, required: true },
    adminName: { type: String, required: true, trim: true },
    adminEmail: { type: String, required: true, trim: true, lowercase: true },
    customerKey: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['talking', 'paid'],
      required: true,
      default: 'talking',
    },
    orderId: { type: mongoose.Schema.Types.ObjectId },
    claimedAt: { type: Date, required: true },
    paidAt: { type: Date },
  },
  { timestamps: true, collection: 'adminachievements' },
);

// A customer appears ONCE per admin — the unique key is the point system.
AdminAchievementSchema.index({ adminId: 1, customerKey: 1 }, { unique: true });
// List $lookup + exclusivity check ("is anyone talking to this customer")
// + the paid hook's {customerKey, status:'talking'} update. Also covers
// stats, which join by customerKey through the orders pipeline.
AdminAchievementSchema.index({ customerKey: 1, status: 1 });

const AdminAchievement =
  (mongoose.models.AdminAchievement as mongoose.Model<IAdminAchievement>) ||
  mongoose.model<IAdminAchievement>('AdminAchievement', AdminAchievementSchema);

export default AdminAchievement;
