import mongoose from 'mongoose';

export interface ICountry {
  _id?: string;
  code: string;
  name: { ar: string; en: string };
  currencyCode: string;
  currencySymbol: string;
  flagEmoji: string;
  isActive: boolean;
  sortOrder: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const CountrySchema = new mongoose.Schema<ICountry>(
  {
    code: {
      type: String,
      required: [true, 'Country code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: [2, 'Country code must be 2 characters'],
      minlength: [2, 'Country code must be 2 characters'],
    },
    name: {
      ar: {
        type: String,
        required: [true, 'Arabic country name is required'],
        trim: true,
      },
      en: {
        type: String,
        required: [true, 'English country name is required'],
        trim: true,
      },
    },
    currencyCode: {
      type: String,
      required: [true, 'Currency code is required'],
      uppercase: true,
      trim: true,
      maxlength: [3, 'Currency code must be 3 characters'],
    },
    currencySymbol: {
      type: String,
      required: [true, 'Currency symbol is required'],
      trim: true,
    },
    flagEmoji: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: null },
  },
  { timestamps: true },
);

CountrySchema.index({ currencyCode: 1 });
CountrySchema.index({ isActive: 1 });
CountrySchema.index({ sortOrder: 1 });

const Country =
  (mongoose.models.Country as mongoose.Model<ICountry>) ||
  mongoose.model<ICountry>('Country', CountrySchema);

export default Country;
