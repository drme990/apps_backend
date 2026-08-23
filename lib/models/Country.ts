import mongoose from 'mongoose';
import type {
  CountryVisibilityMap,
  CountryVisibilityMode,
} from '@/lib/country-visibility';

export interface ICountry {
  _id?: string;
  code: string;
  name: { ar: string; en: string };
  currencyCode: string;
  currencySymbol: string;
  roundingRule:
  | 'nearest-ten'
  | 'nearest-five'
  | 'nearest-fifty'
  | 'nearest-hundred'
  | 'ceil';
  flagEmoji: string;
  isActive: boolean;
  sortOrder: number | null;
  /** Display order for this country's currency in the multi-currency price editor. Null = alphabetical fallback. */
  currencyOrder: number | null;
  region?: string;
  visibilityMode?: CountryVisibilityMode;
  countriesToSee?: CountryVisibilityMap;
  /**
   * Tolerance applied when deciding whether an order is "paid".
   * - `percentage`: order is paid when totalPaid >= fullAmount * (1 - value/100)
   * - `fixnumber`:  order is paid when totalPaid >= fullAmount - value
   * Omit/undefined = no tolerance (exact match required).
   */
  allowRate?: {
    type: 'percentage' | 'fixnumber';
    value: number;
  } | null;
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
    roundingRule: {
      type: String,
      enum: [
        'nearest-ten',
        'nearest-five',
        'nearest-fifty',
        'nearest-hundred',
        'ceil',
      ],
      default: 'ceil',
    },
    flagEmoji: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: null },
    currencyOrder: { type: Number, default: null },
    region: { type: String, trim: true, default: '' },
    visibilityMode: {
      type: String,
      enum: ['all', 'custom'],
      default: 'all',
    },
    countriesToSee: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    allowRate: {
      type: new mongoose.Schema(
        {
          type: {
            type: String,
            enum: ['percentage', 'fixnumber'],
            required: true,
          },
          value: {
            type: Number,
            required: true,
            min: 0,
          },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

CountrySchema.index({ currencyCode: 1 });
CountrySchema.index({ isActive: 1 });
CountrySchema.index({ sortOrder: 1 });
CountrySchema.index({ currencyOrder: 1 });

const Country =
  (mongoose.models.Country as mongoose.Model<ICountry>) ||
  mongoose.model<ICountry>('Country', CountrySchema);

export default Country;
