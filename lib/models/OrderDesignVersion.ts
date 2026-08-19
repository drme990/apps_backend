import mongoose from 'mongoose';

/**
 * Order Design Version — immutable saved-version history.
 *
 * One document per version snapshot. Versions are append-only: existing
 * versions are never edited, deleted, or reordered. A rollback is itself
 * a new version (`trigger: 'admin_restore'`).
 *
 * The collection is shared with the design app, which writes `auto`,
 * `admin_regenerate`, `admin_edit`, and `admin_upload` versions directly
 * via the raw `mongodb` driver (see
 * `manasik_design_webapp/lib/services/design-version-service.ts`). The
 * backend writes `admin_restore` and `admin_delete` events via this
 * Mongoose model and owns the read/restore/delete APIs.
 *
 * Identity (see `order-history-enhanced.md` §4):
 *   - Versions are grouped by `(orderNumber, productId, itemIndex)`.
 *   - `projectId` is metadata only — it changes on regeneration and must
 *     NOT determine the version sequence.
 *   - `itemIndex` is normalized to `null` when omitted so it participates
 *     consistently in unique indexes.
 *
 * Version numbers are atomically allocated via `OrderDesignVersionCounter`
 * (see `order-history-enhanced.md` §5).
 */

export type OrderDesignVersionTrigger =
  | 'auto'
  | 'admin_regenerate'
  | 'admin_edit'
  | 'admin_upload'
  | 'admin_restore'
  | 'admin_delete';

export interface IOrderDesignVersion {
  _id?: string;

  // ── Stable design identity ──────────────────────────────────────────
  orderNumber: string;
  productId: string;
  /** 1-based item index for multi-item orders. Null for single-item. */
  itemIndex?: number | null;

  // ── Immutable history identity ──────────────────────────────────────
  /** Monotonically increasing version number, atomically allocated. */
  version: number;

  /**
   * ID of the design-app project (design instance) that produced this
   * snapshot. Metadata only — NOT the history grouping key.
   */
  projectId: string;

  // ── Immutable rendered asset ────────────────────────────────────────
  archivedUrl: string;
  archivedKey: string;

  // ── Design snapshot ─────────────────────────────────────────────────
  /**
   * Layer array. Stored as Mixed because the layer shape is owned by the
   * design app — the backend just stores and retrieves it verbatim.
   */
  layers: unknown[];
  canvasWidth: number;
  canvasHeight: number;
  backgroundColor?: string;
  backgroundUri?: string;

  // ── Audit information ───────────────────────────────────────────────
  userId: string;
  userName: string;
  userRole: string;

  trigger: OrderDesignVersionTrigger;

  /** Unix timestamp (ms) when the version was created. */
  createdAt: number;

  /** Only populated for `admin_restore` events. */
  restoredFromVersion?: number;

  /** Only populated for `admin_delete` events. */
  isDeletedEvent?: boolean;

  /** Stable hash of the design snapshot (no-op detection). */
  designHash: string;

  /** Idempotency key (webhook retries, admin double-clicks). */
  operationId: string;
}

const OrderDesignVersionSchema = new mongoose.Schema<IOrderDesignVersion>(
  {
    orderNumber: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    itemIndex: { type: Number, default: null, index: true },

    version: { type: Number, required: true },

    projectId: { type: String, required: true },

    archivedUrl: { type: String, required: true },
    archivedKey: { type: String, required: true },

    layers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    canvasWidth: { type: Number, required: true },
    canvasHeight: { type: Number, required: true },
    backgroundColor: { type: String },
    backgroundUri: { type: String },

    userId: { type: String, required: true },
    userName: { type: String, required: true },
    userRole: { type: String, required: true },

    trigger: {
      type: String,
      required: true,
      enum: [
        'auto',
        'admin_regenerate',
        'admin_edit',
        'admin_upload',
        'admin_restore',
        'admin_delete',
      ],
      index: true,
    },

    createdAt: { type: Number, required: true, index: true },

    restoredFromVersion: { type: Number },
    isDeletedEvent: { type: Boolean },

    designHash: { type: String, required: true },
    operationId: { type: String, required: true },
  },
  {
    collection: 'order_design_versions',
    timestamps: false,
    // Disable auto-_id management on subdocuments and minimize empty
    // objects — the design app writes via the raw driver and doesn't
    // expect Mongoose-specific fields.
    minimize: false,
  },
);

// ── Indexes (see `order-history-enhanced.md` §23) ────────────────────────

// Fetch history sorted by version descending (newest first).
OrderDesignVersionSchema.index({ orderNumber: 1, productId: 1, itemIndex: 1, version: -1 });

// Guarantee unique version numbers per identity — combined with the atomic
// counter, this prevents two concurrent saves from both becoming `vN`.
OrderDesignVersionSchema.index(
  { orderNumber: 1, productId: 1, itemIndex: 1, version: 1 },
  { unique: true },
);

// Idempotency — a retry with the same operationId returns the existing
// version instead of creating a duplicate.
OrderDesignVersionSchema.index({ operationId: 1 }, { unique: true });

// Avoid Mongoose model caching issues in dev (matches the pattern used by
// other models in this codebase, e.g. ExecutionNumberCounter).
if (process.env.NODE_ENV !== 'production' && mongoose.models.OrderDesignVersion) {
  mongoose.deleteModel('OrderDesignVersion');
}

const OrderDesignVersion =
  (mongoose.models.OrderDesignVersion as mongoose.Model<IOrderDesignVersion>) ||
  mongoose.model<IOrderDesignVersion>('OrderDesignVersion', OrderDesignVersionSchema);

export default OrderDesignVersion;
