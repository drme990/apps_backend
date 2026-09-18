import mongoose from 'mongoose';

export type ShareCampaignStatus = 'active' | 'inactive' | 'completed';

export interface IShareCampaignSize {
  sizeIndex: number;
  sharesPerPurchase: number;
}

export interface IShareCampaign {
  _id?: string;
  productId: mongoose.Types.ObjectId;
  totalShares: number;
  soldShares: number;
  /** Portion of soldShares added manually by an admin (display only). */
  manualShares?: number;
  /** Log of manual additions — count, date, and the admin who added them. */
  manualShareEntries?: Array<{
    count: number;
    addedAt: Date;
    addedById?: string;
    addedByName?: string;
    addedByEmail?: string;
  }>;
  status: ShareCampaignStatus;
  campaignNumber: number;
  /** Show this campaign's progress on the public product page. */
  displayOnProductPage?: boolean;
  /** Minimum percent shown on the product page (floor, e.g. never show 0%). */
  minDisplayPercent?: number;
  sizes: IShareCampaignSize[];
  createdAt?: Date;
  updatedAt?: Date;
  completedAt?: Date | null;
}

const ShareCampaignSizeSchema = new mongoose.Schema<IShareCampaignSize>(
  {
    sizeIndex: { type: Number, required: true, min: 0 },
    sharesPerPurchase: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const ShareCampaignSchema = new mongoose.Schema<IShareCampaign>(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    totalShares: { type: Number, required: true, min: 2 },
    soldShares: { type: Number, required: true, min: 0, default: 0 },
    manualShares: { type: Number, min: 0, default: 0 },
    manualShareEntries: {
      type: [
        {
          count: { type: Number, required: true, min: 1 },
          addedAt: { type: Date, required: true },
          addedById: { type: String, default: '' },
          addedByName: { type: String, default: '' },
          addedByEmail: { type: String, default: '' },
        },
      ],
      default: [],
    },
    status: {
      type: String,
      required: true,
      enum: ['active', 'inactive', 'completed'],
      default: 'active',
    },
    campaignNumber: { type: Number, required: true, min: 1, default: 1 },
    displayOnProductPage: { type: Boolean, default: false },
    minDisplayPercent: { type: Number, min: 0, max: 100, default: 0 },
    sizes: {
      type: [ShareCampaignSizeSchema],
      required: true,
      validate: {
        validator: (v: IShareCampaignSize[]) => v.length > 0,
        message: 'At least one size is required',
      },
    },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Compound indexes for efficient queries.
// Multiple active campaigns per product are allowed — an order that
// overflows the current active campaign creates a new active one.
ShareCampaignSchema.index({ productId: 1, status: 1 });

// Force re-registration on hot reloads so stale schemas don't persist.
if (mongoose.models.ShareCampaign) {
  delete mongoose.models.ShareCampaign;
}
const ShareCampaign = mongoose.model<IShareCampaign>(
  'ShareCampaign',
  ShareCampaignSchema,
);

export default ShareCampaign;
