import mongoose from 'mongoose';

/**
 * Order Design Version Counter — atomic version allocation.
 *
 * One document per `(orderNumber, productId, itemIndex)` identity. The
 * `nextVersion` field is atomically incremented via `findOneAndUpdate`
 * with `$inc`, so two concurrent saves cannot both allocate the same
 * version number.
 *
 * Combined with the unique index on
 * `(orderNumber, productId, itemIndex, version)` in `OrderDesignVersion`,
 * this guarantees version numbers are monotonically increasing and
 * collision-free under concurrency.
 *
 * See `order-history-enhanced.md` §5.
 */

export interface IOrderDesignVersionCounter {
  _id?: string;
  orderNumber: string;
  productId: string;
  /** 1-based item index for multi-item orders. Null for single-item. */
  itemIndex?: number | null;
  /** The next version number to allocate. */
  nextVersion: number;
}

const OrderDesignVersionCounterSchema = new mongoose.Schema<IOrderDesignVersionCounter>(
  {
    orderNumber: { type: String, required: true },
    productId: { type: String, required: true },
    itemIndex: { type: Number, default: null },
    nextVersion: { type: Number, required: true, default: 1, min: 1 },
  },
  {
    collection: 'design_order_version_counters',
    timestamps: true,
  },
);

// One counter per history identity.
OrderDesignVersionCounterSchema.index(
  { orderNumber: 1, productId: 1, itemIndex: 1 },
  { unique: true },
);

if (process.env.NODE_ENV !== 'production' && mongoose.models.OrderDesignVersionCounter) {
  mongoose.deleteModel('OrderDesignVersionCounter');
}

const OrderDesignVersionCounter =
  (mongoose.models.OrderDesignVersionCounter as mongoose.Model<IOrderDesignVersionCounter>) ||
  mongoose.model<IOrderDesignVersionCounter>(
    'OrderDesignVersionCounter',
    OrderDesignVersionCounterSchema,
  );

export default OrderDesignVersionCounter;
