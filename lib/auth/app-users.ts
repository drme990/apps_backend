import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import type { Model } from 'mongoose';
import User, { IUser as IAdminUser, IUserMethods } from '@/lib/models/User';

export const APP_IDS = ['manasik', 'ghadaq', 'admin_panel'] as const;
export type AppId = (typeof APP_IDS)[number];

export const ADMIN_ALLOWED_PAGES = [
  'products',
  'orders',
  'customers',
  'analytics',
  'booking',
  'coupons',
  'countries',
  'admins',
  'referrals',
  'activityLogs',
  'appearance',
  'exchange',
  'payments',
] as const;

export type AdminAllowedPage = (typeof ADMIN_ALLOWED_PAGES)[number];

export interface IBaseAppUser {
  _id?: string;
  name: string;
  email: string;
  password: string;
  phone?: string;
  country?: string;
  isBanned?: boolean;
  appId: Exclude<AppId, 'admin_panel'>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBaseAppUserMethods {
  comparePassword(candidatePassword: string): Promise<boolean>;
}

type BaseAppUserModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

function buildBaseAppUserModel(
  appId: Exclude<AppId, 'admin_panel'>,
  collection: string,
) {
  const modelName = `User_${appId}`;

  const schema = new mongoose.Schema<IBaseAppUser, BaseAppUserModel>(
    {
      name: { type: String, required: true },
      email: { type: String, required: true, unique: true, lowercase: true },
      password: { type: String, required: true, select: false },
      phone: { type: String, trim: true, default: '' },
      country: { type: String, trim: true, default: '' },
      isBanned: { type: Boolean, default: false, index: true },
      appId: { type: String, enum: [appId], default: appId },
    },
    { timestamps: true, collection },
  );

  schema.index({ email: 1, isBanned: 1 });

  schema.pre('save', async function () {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  });

  schema.methods.comparePassword = async function (candidatePassword: string) {
    return bcrypt.compare(candidatePassword, this.password);
  };

  if (mongoose.models[modelName]) {
    delete mongoose.models[modelName];
  }

  return mongoose.model<IBaseAppUser, BaseAppUserModel>(modelName, schema);
}

const UserManasik = buildBaseAppUserModel('manasik', 'users_manasik');
const UserGhadaq = buildBaseAppUserModel('ghadaq', 'users_ghadaq');

export function getUserModelByAppId(
  appId: AppId,
): BaseAppUserModel | Model<IAdminUser, object, IUserMethods> {
  switch (appId) {
    case 'manasik':
      return UserManasik;
    case 'ghadaq':
      return UserGhadaq;
    case 'admin_panel':
      return User;
    default:
      throw new Error('Invalid appId');
  }
}

export function parseAppId(value: unknown): AppId | null {
  if (typeof value !== 'string') return null;
  return (APP_IDS as readonly string[]).includes(value)
    ? (value as AppId)
    : null;
}
