import mongoose from 'mongoose';

/**
 * Order Design Generation Log
 *
 * Tracks every attempt to generate a design for an order — whether
 * triggered automatically (payment webhook / admin status change) or
 * manually (admin clicked the "Generate Design" button).
 *
 * One document per generation attempt, NOT per product. An attempt
 * may cover multiple products (the backend loops over order items).
 * Per-product results are stored in the `results` array.
 *
 * Used by the admin panel's "Order Design Logs" page to give the
 * admin visibility into:
 *   - When designs were generated
 *   - Whether they were auto or manual
 *   - What triggered them (webhook, status change, admin button)
 *   - Success / failure per product
 *   - Error reasons for debugging
 */

/** Per-product result within a generation attempt. */
export interface IOrderDesignLogResult {
  /** Backend product ID (string ObjectId) */
  productId: string;
  /** Product name snapshot (for display without a DB lookup) */
  productName?: string;
  /** Whether this product's design was generated successfully */
  success: boolean;
  /** Public R2 URL of the generated JPG (only when success=true) */
  url?: string;
  /** Which template variant was used — 'text' or 'image' */
  templateType?: 'text' | 'image';
  /** Design-app project ID (for editing in the design app) */
  projectId?: string;
  /**
   * Machine-readable error code when success=false.
   * Matches the design app's error codes: noTemplate,
   * noBookingProduct, templateNotFound, designAppNotConfigured,
   * callbackSecretNotConfigured, timeout, fetchFailed, unknown.
   */
  errorCode?: string;
  /** Human-readable error message (Arabic fallback) */
  errorMessage?: string;
}

export interface IOrderDesignLog {
  _id?: string;
  /** Order MongoDB _id (string) */
  orderId: string;
  /** Order number (for display + search without a join) */
  orderNumber: string;
  /** Order source — 'manasik' or 'ghadaq' */
  source?: string;
  /** Order status at the time of generation */
  orderStatus?: string;
  /** Whether the order had a reservation photo (determines template type) */
  hasReservationPhoto?: boolean;
  /**
   * How the generation was triggered:
   *  - 'auto_webhook'    — payment webhook transitioned order to paid
   *  - 'auto_admin'      — admin manually changed status to paid/partial
   *  - 'manual_admin'    — admin clicked "Generate Design" button
   */
  trigger: 'auto_webhook' | 'auto_admin' | 'auto_cron' | 'manual_admin';
  /**
   * Overall status of the attempt:
   *  - 'success'   — at least one product generated successfully
   *  - 'partial'   — some products succeeded, some failed
   *  - 'failed'    — all products failed
   *  - 'skipped'   — no products to generate or order already has designs
   */
  status: 'success' | 'partial' | 'failed' | 'skipped';
  /** Total number of products in the attempt */
  totalProducts: number;
  /** Number of products that generated successfully */
  generatedCount: number;
  /** Number of products that failed / were skipped */
  failedCount: number;
  /** Per-product results */
  results: IOrderDesignLogResult[];
  /**
   * Admin user who triggered the generation (only for manual_admin
   * and auto_admin triggers). Null for auto_webhook.
   */
  triggeredByUserId?: string;
  triggeredByUserName?: string;
  triggeredByUserEmail?: string;
  /** Time the generation started */
  startedAt: Date;
  /** Time the generation finished */
  finishedAt: Date;
  /** Duration in milliseconds (finishedAt - startedAt) */
  durationMs: number;
  /** Error message if the entire attempt failed unexpectedly */
  error?: string;
  /** Why the generation was skipped (order not found, not paid, already has designs, etc.) */
  skipReason?: string;
  createdAt?: Date;
}

const OrderDesignLogResultSchema = new mongoose.Schema<IOrderDesignLogResult>(
  {
    productId: { type: String, required: true },
    productName: { type: String },
    success: { type: Boolean, required: true },
    url: { type: String },
    templateType: { type: String, enum: ['text', 'image'] },
    projectId: { type: String },
    errorCode: { type: String },
    errorMessage: { type: String },
  },
  { _id: false },
);

const OrderDesignLogSchema = new mongoose.Schema<IOrderDesignLog>(
  {
    orderId: { type: String, required: true, index: true },
    orderNumber: { type: String, required: true, index: true },
    source: { type: String, enum: ['manasik', 'ghadaq', 'cron'] },
    orderStatus: { type: String },
    hasReservationPhoto: { type: Boolean },
    trigger: {
      type: String,
      required: true,
      enum: ['auto_webhook', 'auto_admin', 'auto_cron', 'manual_admin'],
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['success', 'partial', 'failed', 'skipped'],
      index: true,
    },
    totalProducts: { type: Number, default: 0 },
    generatedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    results: { type: [OrderDesignLogResultSchema], default: [] },
    triggeredByUserId: { type: String },
    triggeredByUserName: { type: String },
    triggeredByUserEmail: { type: String },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    durationMs: { type: Number, default: 0 },
    error: { type: String },
    skipReason: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

OrderDesignLogSchema.index({ createdAt: -1 });
OrderDesignLogSchema.index({ orderId: 1, createdAt: -1 });
OrderDesignLogSchema.index({ status: 1, createdAt: -1 });
OrderDesignLogSchema.index({ trigger: 1, createdAt: -1 });

const OrderDesignLog =
  (mongoose.models.OrderDesignLog as mongoose.Model<IOrderDesignLog>) ||
  mongoose.model<IOrderDesignLog>('OrderDesignLog', OrderDesignLogSchema);

export default OrderDesignLog;
