import mongoose from 'mongoose';

export type ShareCampaignChangeType =
  | 'created'
  | 'status'
  | 'totalShares'
  | 'campaignNumber'
  | 'displayOnProductPage'
  | 'minDisplayPercent'
  | 'movedSharesOut'
  | 'movedSharesIn'
  | 'autoCompleted'
  | 'autoCreated'
  | 'deleted';

export interface IShareCampaignHistory {
  _id?: string;
  campaignId: mongoose.Types.ObjectId;
  productId: mongoose.Types.ObjectId;
  campaignNumber: number;
  /** Snapshot of the product name so history survives product edits/deletes. */
  productName?: { en: string; ar: string } | null;
  changeType: ShareCampaignChangeType;
  previousValue: string | null;
  newValue: string | null;
  /** Free-form context, e.g. "moved to campaign #4" or "order M2-...". */
  details?: string;
  changedByUserId: string;
  changedByUserName: string;
  changedByUserEmail: string;
  createdAt?: Date;
}

const ShareCampaignHistorySchema =
  new mongoose.Schema<IShareCampaignHistory>(
    {
      campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
      },
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
      },
      campaignNumber: { type: Number, required: true },
      productName: {
        en: { type: String, default: '' },
        ar: { type: String, default: '' },
      },
      changeType: {
        type: String,
        required: true,
        enum: [
          'created',
          'status',
          'totalShares',
          'campaignNumber',
          'displayOnProductPage',
          'minDisplayPercent',
          'movedSharesOut',
          'movedSharesIn',
          'autoCompleted',
          'autoCreated',
          'deleted',
        ],
        index: true,
      },
      previousValue: { type: String, default: null },
      newValue: { type: String, default: null },
      details: { type: String, default: '' },
      changedByUserId: { type: String, required: true, index: true },
      changedByUserName: { type: String, required: true },
      changedByUserEmail: { type: String, required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
  );

ShareCampaignHistorySchema.index({ campaignId: 1, createdAt: -1 });
ShareCampaignHistorySchema.index({ productId: 1, createdAt: -1 });

const ShareCampaignHistory =
  (mongoose.models.ShareCampaignHistory as mongoose.Model<IShareCampaignHistory>) ||
  mongoose.model<IShareCampaignHistory>(
    'ShareCampaignHistory',
    ShareCampaignHistorySchema,
  );

export default ShareCampaignHistory;
