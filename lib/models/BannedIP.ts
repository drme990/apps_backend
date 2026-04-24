import mongoose from 'mongoose';

export interface IBannedIP {
  _id?: string;
  ipAddress: string;
  bannedBy?: string;
  reason?: string;
  bannedAt: Date;
  expiresAt?: Date;
}

type BannedIPModel = mongoose.Model<IBannedIP>;

const BannedIPSchema = new mongoose.Schema<IBannedIP, BannedIPModel>(
  {
    ipAddress: {
      type: String,
      required: [true, 'IP address is required'],
      unique: true,
      index: true,
    },
    bannedBy: {
      type: String,
      ref: 'User',
    },
    reason: {
      type: String,
      default: 'User ban',
    },
    bannedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
    },
  },
  { timestamps: true, collection: 'banned_ips' },
);

BannedIPSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Force re-register on HMR in dev
if (mongoose.models.BannedIP) {
  delete mongoose.models.BannedIP;
}

const BannedIP: BannedIPModel = mongoose.model<IBannedIP, BannedIPModel>(
  'BannedIP',
  BannedIPSchema,
);

export default BannedIP;

/**
 * Check if an IP is banned
 */
export async function isIpBanned(ipAddress: string): Promise<boolean> {
  try {
    const banned = await BannedIP.findOne({
      ipAddress,
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: new Date() } },
      ],
    });
    return !!banned;
  } catch (error) {
    console.error('Error checking IP ban status:', error);
    return false;
  }
}

/**
 * Ban an IP address
 */
export async function banIpAddress(
  ipAddress: string,
  bannedBy?: string,
  reason?: string,
  expiresAt?: Date,
): Promise<void> {
  try {
    await BannedIP.findOneAndUpdate(
      { ipAddress },
      {
        ipAddress,
        bannedBy,
        reason: reason || 'User ban',
        bannedAt: new Date(),
        expiresAt,
      },
      {
        upsert: true,
        returnDocument: 'after',
      },
    );
  } catch (error) {
    console.error('Error banning IP address:', error);
    throw error;
  }
}

/**
 * Unban an IP address
 */
export async function unbanIpAddress(ipAddress: string): Promise<void> {
  try {
    await BannedIP.deleteOne({ ipAddress });
  } catch (error) {
    console.error('Error unbanning IP address:', error);
    throw error;
  }
}
