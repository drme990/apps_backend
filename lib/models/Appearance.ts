import mongoose from 'mongoose';

export interface IAppearance {
  _id?: string;
  project: 'ghadaq' | 'manasik';
  worksImages: { row1: string[]; row2: string[] };
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
  },
  { timestamps: true },
);

const Appearance =
  (mongoose.models.Appearance as mongoose.Model<IAppearance>) ||
  mongoose.model<IAppearance>('Appearance', AppearanceSchema);

export default Appearance;
