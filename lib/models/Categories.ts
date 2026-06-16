import mongoose from 'mongoose';

export interface ICategory {
  _id?: string;
  name: string;
  categoryNumber: number;
  color: string;
  products: (mongoose.Types.ObjectId | string)[];
  createdAt?: Date;
  updatedAt?: Date;
}

const CategorySchema = new mongoose.Schema<ICategory>(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      maxlength: [100, 'Category name cannot exceed 100 characters'],
    },
    categoryNumber: {
      type: Number,
      required: [true, 'Category number is required'],
      unique: true,
      index: true,
    },
    color: {
      type: String,
      required: [true, 'Category color is required'],
      trim: true,
      match: [/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/, 'Color must be a valid hex color'],
    },
    products: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product',
      },
    ],
  },
  { timestamps: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.Category) {
  mongoose.deleteModel('Category');
}

const Category =
  (mongoose.models.Category as mongoose.Model<ICategory>) ||
  mongoose.model<ICategory>('Category', CategorySchema);

export default Category;
