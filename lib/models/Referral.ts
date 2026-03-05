import mongoose from 'mongoose';

export interface IReferral {
  _id?: string;
  name: string;
  referralId: string;
  phone: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const ReferralSchema = new mongoose.Schema<IReferral>(
  {
    name: { type: String, required: true, trim: true },
    referralId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    phone: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

const Referral =
  (mongoose.models.Referral as mongoose.Model<IReferral>) ||
  mongoose.model<IReferral>('Referral', ReferralSchema);

export default Referral;
