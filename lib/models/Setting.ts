import mongoose from 'mongoose';

/**
 * Generic key-value settings store for app-wide configuration.
 * Each document has a unique `key` and an arbitrary `value` object.
 */
export interface ISetting {
  _id?: string;
  key: string;
  value: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

const SettingSchema = new mongoose.Schema<ISetting>(
  {
    key: { type: String, required: true, unique: true, trim: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

const Setting =
  (mongoose.models.Setting as mongoose.Model<ISetting>) ||
  mongoose.model<ISetting>('Setting', SettingSchema);

export default Setting;

// ─── Default phone numbers setting ─────────────────────────────────────────
// Key: "defaultPhones"
// Value: { manasik: string, ghadaq: string }
// Used by the manasik-v2 and ghadaq apps as the fallback WhatsApp number
// when a referral doesn't have a phone number.
//
// There are NO hardcoded fallback numbers — if the DB has no setting,
// getDefaultPhones() returns empty strings and the apps hide the
// WhatsApp button.

export const DEFAULT_PHONES_KEY = 'defaultPhones';

export interface DefaultPhonesValue {
  manasik: string;
  ghadaq: string;
}

export async function getDefaultPhones(): Promise<DefaultPhonesValue> {
  const doc = await Setting.findOne({ key: DEFAULT_PHONES_KEY }).lean();
  if (!doc) return { manasik: '', ghadaq: '' };
  const value = doc.value as Partial<DefaultPhonesValue>;
  return {
    manasik: value.manasik || '',
    ghadaq: value.ghadaq || '',
  };
}

export async function setDefaultPhones(phones: DefaultPhonesValue): Promise<void> {
  await Setting.findOneAndUpdate(
    { key: DEFAULT_PHONES_KEY },
    { key: DEFAULT_PHONES_KEY, value: phones },
    { upsert: true, new: true },
  );
}
