/**
 * Design version history service (backend side).
 *
 * The backend owns restore and delete operations because they require
 * admin authorization and updates to the order's current-design pointer.
 * The design app owns create operations (auto / admin_edit / admin_upload
 * / admin_regenerate) — see
 * `manasik_design_webapp/lib/services/design-version-service.ts`.
 *
 * This module provides:
 *   - `allocateVersionNumber` — atomic version allocation via
 *     `OrderDesignVersionCounter` (mirrors the design app's allocator so
 *     both apps share the same counter collection).
 *   - `restoreVersion` — creates a new `admin_restore` version whose
 *     snapshot is copied from the target version, then updates the
 *     order's `designUrls[].url` + `currentVersion` and resets review
 *     state. Atomic via MongoDB transaction when available.
 *   - `recordDeleteEvent` — creates a new `admin_delete` version that
 *     preserves the last valid snapshot, then clears the order's
 *     `designUrls` entry and sets `currentVersion = null`.
 *
 * See `order-history-enhanced.md` §9–§13.
 */

import mongoose from 'mongoose';
import Order, { type IOrder, type IOrderDesignUrl } from '@/lib/models/Order';
import OrderDesignVersion, {
  type IOrderDesignVersion,
  type OrderDesignVersionTrigger,
} from '@/lib/models/OrderDesignVersion';
import OrderDesignVersionCounter from '@/lib/models/OrderDesignVersionCounter';
import { logActivity } from '@/lib/services/logger';

/**
 * Stable identity for a single design within an order.
 */
export interface DesignVersionIdentity {
  orderNumber: string;
  productId: string;
  itemIndex?: number | null;
}

export interface DesignVersionActor {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: string;
}

/**
 * Build a stable MongoDB filter for a history identity. `itemIndex` is
 * normalized to `null` when omitted so it participates consistently in
 * unique indexes and queries.
 */
export function identityFilter(identity: DesignVersionIdentity): Record<string, unknown> {
  return {
    orderNumber: identity.orderNumber,
    productId: identity.productId,
    itemIndex: identity.itemIndex ?? null,
  };
}

/**
 * Atomically allocate the next version number for a history identity.
 *
 * Uses `findOneAndUpdate` with `$inc` on a per-identity counter document.
 * Combined with the unique index on `(orderNumber, productId, itemIndex,
 * version)`, this guarantees two concurrent saves cannot both become
 * `vN` — even when one allocation happens in the design app and the
 * other in the backend (they share the same counter collection).
 */
export async function allocateVersionNumber(
  identity: DesignVersionIdentity,
): Promise<number> {
  const filter = identityFilter(identity);
  const result = await OrderDesignVersionCounter.findOneAndUpdate(
    filter,
    { $inc: { nextVersion: 1 } },
    { upsert: true, new: true },
  );
  if (!result) {
    // Should never happen with upsert + new:true, but guard anyway.
    await OrderDesignVersionCounter.updateOne(
      filter,
      { $setOnInsert: { nextVersion: 1 } },
      { upsert: true },
    );
    const retry = await OrderDesignVersionCounter.findOneAndUpdate(
      filter,
      { $inc: { nextVersion: 1 } },
      { new: true },
    );
    return retry?.nextVersion ?? 1;
  }
  return result.nextVersion;
}

/**
 * Find the latest (highest version number) version for an identity.
 * Returns null if no versions exist.
 */
export async function findLatestVersion(
  identity: DesignVersionIdentity,
): Promise<IOrderDesignVersion | null> {
  return OrderDesignVersion.findOne(identityFilter(identity)).sort({ version: -1 }).lean();
}

/**
 * Find a specific version by identity + version number.
 */
export async function findVersion(
  identity: DesignVersionIdentity,
  version: number,
): Promise<IOrderDesignVersion | null> {
  return OrderDesignVersion.findOne({
    ...identityFilter(identity),
    version,
  }).lean();
}

/**
 * Find an existing version by its `operationId`. Used for idempotency:
 * if a retry carries the same operationId, return the existing version
 * instead of creating a duplicate.
 */
export async function findVersionByOperationId(
  operationId: string,
): Promise<IOrderDesignVersion | null> {
  if (!operationId) return null;
  return OrderDesignVersion.findOne({ operationId }).lean();
}

/**
 * List all versions for an identity, newest first.
 */
export async function listVersions(
  identity: DesignVersionIdentity,
): Promise<IOrderDesignVersion[]> {
  return OrderDesignVersion.find(identityFilter(identity))
    .sort({ version: -1 })
    .lean();
}

/**
 * Insert a version document. Used by restore/delete events. The snapshot
 * fields (`layers`, `canvasWidth`, ...) are copied from a target version
 * by the caller.
 *
 * Pass a `session` when called inside a transaction so the insert is
 * part of the same atomic operation as the order update.
 */
async function insertVersion(
  doc: Omit<IOrderDesignVersion, '_id'>,
  session?: mongoose.ClientSession,
): Promise<IOrderDesignVersion> {
  if (session) {
    const [created] = await OrderDesignVersion.create([doc], { session });
    return created.toObject();
  }
  const created = await OrderDesignVersion.create(doc);
  return created.toObject();
}

/**
 * Resolve the order's design entry matching `productId`, including its
 * 1-based `itemIndex` derived from the order's items array.
 *
 * The `itemIndex` is determined by the position of the matching item in
 * `order.items` (1-based). For single-item orders this is always 1.
 */
export function resolveDesignIdentity(
  order: IOrder,
  productId: string,
): { identity: DesignVersionIdentity; designIndex: number } | null {
  const items = order.items || [];
  const itemIndex = items.findIndex((i) => String(i.productId) === String(productId));
  if (itemIndex === -1) {
    // The product may have been removed from the order, but the design
    // entry can still exist. Fall back to itemIndex=1 (single-item).
    const designIndex = (order.designUrls || []).findIndex(
      (d) => String(d.productId) === String(productId),
    );
    if (designIndex === -1) return null;
    return {
      identity: { orderNumber: order.orderNumber, productId, itemIndex: null },
      designIndex,
    };
  }
  const designIndex = (order.designUrls || []).findIndex(
    (d) => String(d.productId) === String(productId),
  );
  return {
    identity: {
      orderNumber: order.orderNumber,
      productId,
      itemIndex: itemIndex + 1, // 1-based
    },
    designIndex,
  };
}

// ─── Restore ─────────────────────────────────────────────────────────────

export interface RestoreResult {
  restoredFromVersion: number;
  newVersion: number;
  currentVersion: number;
  url: string;
}

/**
 * Restore a previous version.
 *
 * Treats restore as a NEW history event (see `order-history-enhanced.md`
 * §9): the original version is never touched. A new version is created
 * with `trigger: 'admin_restore'` and `restoredFromVersion` pointing to
 * the target. The new version's snapshot is a verbatim copy of the
 * target's snapshot.
 *
 * Then the order's `designUrls[].url` is updated to the target's
 * `archivedUrl`, `currentVersion` is set to the new version, and the
 * review state is reset (the restored design hasn't been reviewed yet).
 *
 * Atomic via MongoDB transaction when the deployment supports it. Falls
 * back to sequential writes otherwise — the unique index on
 * `(identity, version)` prevents duplicate version numbers regardless.
 */
export async function restoreVersion(params: {
  order: IOrder;
  identity: DesignVersionIdentity;
  designIndex: number;
  targetVersion: number;
  actor: DesignVersionActor;
  operationId: string;
}): Promise<RestoreResult> {
  const { order, identity, designIndex, targetVersion, actor, operationId } = params;

  // ── 1. Find the target version ──────────────────────────────────────
  const target = await findVersion(identity, targetVersion);
  if (!target) {
    throw new Error('TARGET_VERSION_NOT_FOUND');
  }
  if (target.isDeletedEvent) {
    // Restoring a deletion event itself doesn't make sense — the admin
    // should restore the previous valid version. The UI hides restore on
    // delete events, but guard anyway.
    throw new Error('CANNOT_RESTORE_DELETE_EVENT');
  }

  // ── 2. Allocate the next version number ─────────────────────────────
  const newVersion = await allocateVersionNumber(identity);

  // ── 3. Create the restore version (snapshot copied from target) ─────
  const restoreDoc: Omit<IOrderDesignVersion, '_id'> = {
    orderNumber: target.orderNumber,
    productId: target.productId,
    itemIndex: target.itemIndex ?? null,
    version: newVersion,
    projectId: target.projectId,
    archivedUrl: target.archivedUrl,
    archivedKey: target.archivedKey,
    layers: target.layers,
    canvasWidth: target.canvasWidth,
    canvasHeight: target.canvasHeight,
    backgroundColor: target.backgroundColor,
    backgroundUri: target.backgroundUri,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    trigger: 'admin_restore',
    createdAt: Date.now(),
    restoredFromVersion: target.version,
    designHash: target.designHash,
    operationId,
  };

  // ── 4. Update the order + insert the version ────────────────────────
  // Try a transaction first; fall back to sequential writes if the
  // deployment doesn't support transactions (e.g. standalone MongoDB).
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await insertVersion(restoreDoc, session);

      if (designIndex >= 0) {
        await Order.updateOne(
          { _id: order._id, 'designUrls.productId': target.productId },
          {
            $set: {
              'designUrls.$.url': target.archivedUrl,
              'designUrls.$.currentVersion': newVersion,
              'designUrls.$.reviewed': false,
              'designUrls.$.reviewedAt': null,
              'designUrls.$.reviewedBy': null,
              'designUrls.$.projectId': target.projectId,
              statusUpdateTime: new Date(),
            },
          },
        ).session(session);
      } else {
        // The design entry was missing (e.g. after a delete that cleared
        // it). Re-add it pointing to the restored version.
        const newEntry: IOrderDesignUrl = {
          productId: target.productId,
          url: target.archivedUrl,
          templateType: 'text',
          projectId: target.projectId,
          createdAt: new Date(),
          reviewed: false,
          currentVersion: newVersion,
        };
        await Order.updateOne(
          { _id: order._id },
          {
            $push: { designUrls: newEntry as unknown as Record<string, unknown> },
            $set: { statusUpdateTime: new Date() },
          },
        ).session(session);
      }
    });
  } catch (txError) {
    // Retry without a transaction — some deployments (replica-set-less
    // dev environments) don't support transactions. The unique index on
    // (identity, version) still guarantees no duplicate version numbers.
    const isTxUnsupported =
      txError instanceof Error &&
      /transactions|replica|standalone|not supported/i.test(txError.message);
    if (!isTxUnsupported) throw txError;

    await insertVersion(restoreDoc);
    if (designIndex >= 0) {
      await Order.updateOne(
        { _id: order._id, 'designUrls.productId': target.productId },
        {
          $set: {
            'designUrls.$.url': target.archivedUrl,
            'designUrls.$.currentVersion': newVersion,
            'designUrls.$.reviewed': false,
            'designUrls.$.reviewedAt': null,
            'designUrls.$.reviewedBy': null,
            'designUrls.$.projectId': target.projectId,
            statusUpdateTime: new Date(),
          },
        },
      );
    } else {
      const newEntry: IOrderDesignUrl = {
        productId: target.productId,
        url: target.archivedUrl,
        templateType: 'text',
        projectId: target.projectId,
        createdAt: new Date(),
        reviewed: false,
        currentVersion: newVersion,
      };
      await Order.updateOne(
        { _id: order._id },
        {
          $push: { designUrls: newEntry as unknown as Record<string, unknown> },
          $set: { statusUpdateTime: new Date() },
        },
      );
    }
  } finally {
    session.endSession();
  }

  // ── 5. Activity log (best-effort) ───────────────────────────────────
  try {
    await logActivity({
      action: 'restore_design',
      resource: 'order',
      resourceId: String(order._id),
      userId: actor.userId,
      userName: actor.userName,
      userEmail: actor.userEmail,
      details: JSON.stringify({
        orderNumber: order.orderNumber,
        productId: target.productId,
        itemIndex: target.itemIndex ?? null,
        targetVersion: target.version,
        resultingVersion: newVersion,
      }),
    });
  } catch (logError) {
    console.error('[restoreVersion] logActivity failed:', logError);
  }

  return {
    restoredFromVersion: target.version,
    newVersion,
    currentVersion: newVersion,
    url: target.archivedUrl,
  };
}

// ─── Delete event ────────────────────────────────────────────────────────

export interface DeleteEventResult {
  deletedVersion: number;
  previousVersion: number | null;
}

/**
 * Record a deletion event for a design.
 *
 * Instead of creating an empty snapshot (the old behavior, which weakened
 * the history), this creates a new `admin_delete` version that preserves
 * the last valid snapshot (see `order-history-enhanced.md` §12). The
 * order's `designUrls` entry is removed and `currentVersion` becomes
 * null. All immutable history remains available for restore.
 *
 * `r2KeysToDelete` is the list of current (mutable) R2 keys to delete —
 * the immutable version archives are NEVER deleted by this operation.
 * The caller (the DELETE designs route) handles R2 cleanup of the
 * mutable current-image keys separately.
 */
export async function recordDeleteEvent(params: {
  order: IOrder;
  identity: DesignVersionIdentity;
  designIndex: number;
  actor: DesignVersionActor;
  operationId: string;
}): Promise<DeleteEventResult> {
  const { order, identity, designIndex, actor, operationId } = params;

  // ── 1. Find the current (latest) version ─────────────────────────────
  const latest = await findLatestVersion(identity);
  const previousVersion = latest && !latest.isDeletedEvent ? latest.version : null;

  // ── 2. Allocate the next version number ──────────────────────────────
  const newVersion = await allocateVersionNumber(identity);

  // ── 3. Create the delete event ───────────────────────────────────────
  // Preserve the last valid snapshot. If there's no prior version (edge
  // case: delete called on a design with no history), record an empty
  // snapshot so the event still exists in the audit trail.
  const deleteDoc: Omit<IOrderDesignVersion, '_id'> = latest
    ? {
      orderNumber: latest.orderNumber,
      productId: latest.productId,
      itemIndex: latest.itemIndex ?? null,
      version: newVersion,
      projectId: latest.projectId,
      archivedUrl: latest.archivedUrl,
      archivedKey: latest.archivedKey,
      layers: latest.layers,
      canvasWidth: latest.canvasWidth,
      canvasHeight: latest.canvasHeight,
      backgroundColor: latest.backgroundColor,
      backgroundUri: latest.backgroundUri,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      trigger: 'admin_delete',
      createdAt: Date.now(),
      restoredFromVersion: previousVersion ?? undefined,
      isDeletedEvent: true,
      designHash: latest.designHash,
      operationId,
    }
    : {
      orderNumber: identity.orderNumber,
      productId: identity.productId,
      itemIndex: identity.itemIndex ?? null,
      version: newVersion,
      projectId: 'unknown',
      archivedUrl: '',
      archivedKey: '',
      layers: [],
      canvasWidth: 0,
      canvasHeight: 0,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      trigger: 'admin_delete',
      createdAt: Date.now(),
      isDeletedEvent: true,
      designHash: '',
      operationId,
    };

  await insertVersion(deleteDoc);

  // ── 4. Clear the active design pointer ───────────────────────────────
  // Remove the designUrls entry (matches the existing DELETE behavior —
  // the admin panel refetches and the card shows "no design yet"). The
  // history remains fully available via the history modal.
  if (designIndex >= 0) {
    await Order.updateOne(
      { _id: order._id },
      {
        $pull: { designUrls: { productId: identity.productId } },
        $set: { statusUpdateTime: new Date() },
      },
    );
  } else {
    await Order.updateOne(
      { _id: order._id },
      { $set: { statusUpdateTime: new Date() } },
    );
  }

  return {
    deletedVersion: newVersion,
    previousVersion,
  };
}

/**
 * Helper: build an `operationId` for a restore request. Stable per
 * (order, product, target) so an accidental double-click is idempotent.
 */
export function buildRestoreOperationId(
  identity: DesignVersionIdentity,
  targetVersion: number,
): string {
  return `restore:${identity.orderNumber}:${identity.productId}:${identity.itemIndex ?? 1}:${targetVersion}`;
}

/**
 * Helper: build an `operationId` for a delete request. Stable per
 * (order, product) so an accidental double-click is idempotent.
 */
export function buildDeleteOperationId(identity: DesignVersionIdentity): string {
  return `delete:${identity.orderNumber}:${identity.productId}:${identity.itemIndex ?? 1}`;
}

// ─── Upload event ────────────────────────────────────────────────────────

export interface UploadEventResult {
  newVersion: number;
  currentVersion: number;
  url: string;
}

/**
 * Record an `admin_upload` event — the admin uploaded a replacement JPG
 * directly (see `order-history-enhanced.md` §8).
 *
 * Unlike the design-app-created triggers, the backend writes this event
 * because the upload goes through the backend's PATCH designs route. The
 * uploaded image is already in R2 at a unique key (the admin panel's
 * `uploadImageToR2` generates a unique path per upload), so we use it
 * directly as the `archivedUrl` — it's effectively immutable since no
 * one will overwrite that specific key.
 *
 * The snapshot (layers, canvas) is empty for uploads — there's no
 * editable design state, just a raw JPG. The `archivedUrl` is the
 * source of truth for the visual.
 *
 * After recording the event, the caller (PATCH designs route) updates
 * `designUrls[].url` and `currentVersion` to point to the new version.
 */
export async function recordUploadEvent(params: {
  order: IOrder;
  identity: DesignVersionIdentity;
  designIndex: number;
  /** The uploaded image's R2 URL (already uploaded by the admin panel). */
  uploadedUrl: string;
  /** The R2 key extracted from the uploaded URL. */
  uploadedKey: string;
  actor: DesignVersionActor;
  operationId: string;
}): Promise<UploadEventResult> {
  const { order, identity, designIndex, uploadedUrl, uploadedKey, actor, operationId } = params;

  // ── Idempotency: return existing if this operation already ran ──────
  const existing = await findVersionByOperationId(operationId);
  if (existing) {
    return {
      newVersion: existing.version,
      currentVersion: existing.version,
      url: uploadedUrl,
    };
  }

  // ── Allocate + insert ───────────────────────────────────────────────
  const newVersion = await allocateVersionNumber(identity);

  const uploadDoc: Omit<IOrderDesignVersion, '_id'> = {
    orderNumber: identity.orderNumber,
    productId: identity.productId,
    itemIndex: identity.itemIndex ?? null,
    version: newVersion,
    // No design instance project for a raw upload — use a placeholder.
    projectId: 'upload',
    archivedUrl: uploadedUrl,
    archivedKey: uploadedKey,
    // No editable design state for a raw upload.
    layers: [],
    canvasWidth: 0,
    canvasHeight: 0,
    userId: actor.userId,
    userName: actor.userName,
    userRole: actor.userRole,
    trigger: 'admin_upload',
    createdAt: Date.now(),
    designHash: `upload:${uploadedKey}`,
    operationId,
  };

  await insertVersion(uploadDoc);

  // ── Update the order's current-design pointer ───────────────────────
  if (designIndex >= 0) {
    await Order.updateOne(
      { _id: order._id, 'designUrls.productId': identity.productId },
      {
        $set: {
          'designUrls.$.url': uploadedUrl,
          'designUrls.$.currentVersion': newVersion,
          'designUrls.$.reviewed': false,
          'designUrls.$.reviewedAt': null,
          'designUrls.$.reviewedBy': null,
          statusUpdateTime: new Date(),
        },
      },
    );
  } else {
    // No existing design entry — add one.
    const newEntry: IOrderDesignUrl = {
      productId: identity.productId,
      url: uploadedUrl,
      templateType: 'text',
      createdAt: new Date(),
      reviewed: false,
      currentVersion: newVersion,
    };
    await Order.updateOne(
      { _id: order._id },
      {
        $push: { designUrls: newEntry as unknown as Record<string, unknown> },
        $set: { statusUpdateTime: new Date() },
      },
    );
  }

  return {
    newVersion,
    currentVersion: newVersion,
    url: uploadedUrl,
  };
}

/**
 * Helper: build an `operationId` for an upload request. Includes a
 * timestamp so each upload is a distinct event (the admin might upload
 * multiple replacements over time).
 */
export function buildUploadOperationId(
  identity: DesignVersionIdentity,
  uploadedKey: string,
): string {
  return `upload:${identity.orderNumber}:${identity.productId}:${identity.itemIndex ?? 1}:${uploadedKey}`;
}

/**
 * Map a version trigger to a human-readable label for the activity log
 * and admin UI. The admin panel also has translations for these.
 */
export function triggerLabel(trigger: OrderDesignVersionTrigger): string {
  switch (trigger) {
    case 'auto':
      return 'Auto generation';
    case 'admin_regenerate':
      return 'Admin regenerate';
    case 'admin_edit':
      return 'Admin edit';
    case 'admin_upload':
      return 'Admin upload';
    case 'admin_restore':
      return 'Admin restore';
    case 'admin_delete':
      return 'Admin delete';
    default:
      return trigger;
  }
}
