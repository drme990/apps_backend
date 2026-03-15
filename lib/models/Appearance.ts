import mongoose from 'mongoose';

export interface IAppearance {
  _id?: string;
  project: 'ghadaq' | 'manasik';
  worksImages: { row1: string[]; row2: string[] };
  whatsAppDefaultMessage?: string;
  bannerText?: { ar: string; en: string };
  createdAt?: Date;
  updatedAt?: Date;
}

const AppearanceSchema = new mongoose.Schema<IAppearance>(
  {
    project: {
      type: String,
      required: true,
      unique: true,
      index: true,
      enum: ['ghadaq', 'manasik'],
    },
    worksImages: {
      row1: { type: [String], default: [] },
      row2: { type: [String], default: [] },
    },
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
