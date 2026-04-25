import mongoose from 'mongoose';

export interface IAudioReview {
  id: string;
  url: string;
  nameAr: string;
  nameEn: string;
  userImage: string;
  platform: 'ghadaq' | 'manasik' | 'shared';
  language: 'ar' | 'en' | 'shared';
  isMain: boolean;
}

export interface IAppearance {
  _id?: string;
  project: 'ghadaq' | 'manasik' | 'shared';
  worksImages: { row1: string[]; row2: string[] };
  audioReviews?: IAudioReview[];
  whatsAppDefaultMessage?: string;
  bannerText?: { ar: string; en: string };
  createdAt?: Date;
  updatedAt?: Date;
}

const AudioReviewSchema = new mongoose.Schema<IAudioReview>(
  {
    id: { type: String, required: true },
    url: { type: String, required: true },
    nameAr: { type: String, default: 'مستخدم', trim: true },
    nameEn: { type: String, default: 'User', trim: true },
    userImage: { type: String, default: '', trim: true },
    platform: {
      type: String,
      required: true,
      enum: ['ghadaq', 'manasik', 'shared'],
      index: true,
    },
    language: {
      type: String,
      required: true,
      enum: ['ar', 'en', 'shared'],
      index: true,
    },
    isMain: { type: Boolean, default: false, index: true },
  },
  { _id: false },
);

const AppearanceSchema = new mongoose.Schema<IAppearance>(
  {
    project: {
      type: String,
      required: true,
      unique: true,
      index: true,
      enum: ['ghadaq', 'manasik', 'shared'],
    },
    worksImages: {
      row1: { type: [String], default: [] },
      row2: { type: [String], default: [] },
    },
    audioReviews: { type: [AudioReviewSchema], default: [] },
    whatsAppDefaultMessage: {
      type: String,
      trim: true,
      default: '',
    },
    bannerText: {
      ar: {
        type: String,
        trim: true,
        default: '',
      },
      en: {
        type: String,
        trim: true,
        default: '',
      },
    },
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.Appearance) {
  mongoose.deleteModel('Appearance');
}

const Appearance =
  (mongoose.models.Appearance as mongoose.Model<IAppearance>) ||
  mongoose.model<IAppearance>('Appearance', AppearanceSchema);

export default Appearance;
