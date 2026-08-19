import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Order, { type IOrder } from '@/lib/models/Order';
import { logActivity } from '@/lib/services/logger';
import { deleteMultipleR2Objects, extractR2Key } from '@/lib/services/r2';
import {
  buildDeleteOperationId,
  buildUploadOperationId,
  recordDeleteEvent,
  recordUploadEvent,
  resolveDesignIdentity,
} from '@/lib/services/design-version-history';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/admin/orders/[id]/designs
 *
 * Updates a single design (identified by `productId`). Supports two
 * independent operations (either or both can be sent in one request):
 *   - `reviewed` (boolean) — marks the design reviewed / not-reviewed.
 *     Used by the "order-designs" page and the order detail modal so
 *     admins with `orderDesigns` access can track which generated
 *     designs have already been checked.
 *   - `url` (string) — replaces the design's image with an admin-uploaded
 *     one (e.g. via the "upload" action on the order-designs page). This
 *     resets `reviewed` back to `false` unless `reviewed` was explicitly
 *     provided in the same request, since the image content changed.
 *
 * Body: { productId: string; reviewed?: boolean; url?: string }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const productId = body?.productId;
    const reviewed = body?.reviewed;
    const url = body?.url;

    if (typeof productId !== 'string' || !productId) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing productId' } },
        { status: 400 },
      );
    }
    const hasReviewed = typeof reviewed === 'boolean';
    const hasUrl = typeof url === 'string' && url.trim().length > 0;
    if (!hasReviewed && !hasUrl) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Nothing to update' } },
        { status: 400 },
      );
    }

    const order = (await Order.findById(id).lean()) as IOrder | null;
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    const designUrls = order.designUrls || [];
    const designIndex = designUrls.findIndex((d) => d.productId === productId);

    // If the design doesn't exist yet and a URL is provided, ADD it
    // (used by the "upload design" action when there's no generated design).
    if (designIndex === -1 && hasUrl) {
      // ── Record an admin_upload history event ──────────────────────────
      // The uploaded image is already in R2 at a unique key (the admin
      // panel's upload helper generates a unique path). We use it as the
      // archivedUrl — it's effectively immutable since no one will
      // overwrite that specific key.
      const uploadedKey = extractR2Key(url) || '';
      const resolved = resolveDesignIdentity(order, productId);
      const identity = resolved
        ? resolved.identity
        : { orderNumber: order.orderNumber, productId, itemIndex: null };
      const actor = {
        userId: auth.user.userId,
        userName: auth.user.name || auth.user.email,
        userEmail: auth.user.email,
        userRole: auth.user.role || 'admin',
      };
      let uploadVersion: number | undefined;
      try {
        const uploadResult = await recordUploadEvent({
          order,
          identity,
          designIndex: -1,
          uploadedUrl: url,
          uploadedKey,
          actor,
          operationId: buildUploadOperationId(identity, uploadedKey),
        });
        uploadVersion = uploadResult.newVersion;
      } catch (uploadError) {
        console.error(
          '[PATCH /api/admin/orders/[id]/designs] recordUploadEvent failed:',
          uploadError,
        );
      }

      const newDesign = {
        productId,
        url,
        templateType: 'text' as const,
        reviewed: hasReviewed ? reviewed : false,
        reviewedAt: hasReviewed && reviewed ? new Date() : undefined,
        reviewedBy: hasReviewed && reviewed ? (auth.user.name || auth.user.email) : undefined,
        createdAt: new Date(),
        currentVersion: uploadVersion ?? null,
      };
      await Order.updateOne(
        { _id: id },
        { $push: { designUrls: newDesign as Record<string, unknown> } },
      );

      try {
        await logActivity({
          action: 'upload_design',
          resource: 'order',
          resourceId: id,
          userId: auth.user.userId,
          userName: auth.user.name,
          userEmail: auth.user.email,
          details: JSON.stringify({
            orderNumber: order.orderNumber,
            productId,
            uploadedImage: true,
            version: uploadVersion,
          }),
        });
      } catch (logError) {
        console.error('[PATCH /api/admin/orders/[id]/designs] logActivity failed:', logError);
      }

      return NextResponse.json({ success: true, data: { productId, reviewed: newDesign.reviewed, url, version: uploadVersion } });
    }

    if (designIndex === -1) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Design not found' } },
        { status: 404 },
      );
    }

    // Replacing the image resets the review status, unless the caller
    // also explicitly set `reviewed` in the same request.
    const nextReviewed = hasReviewed ? reviewed : (hasUrl ? false : designUrls[designIndex].reviewed);

    const setFields: Record<string, unknown> = {
      'designUrls.$.reviewed': nextReviewed,
      'designUrls.$.reviewedAt': nextReviewed ? new Date() : null,
      'designUrls.$.reviewedBy': nextReviewed ? (auth.user.name || auth.user.email) : null,
    };
    if (hasUrl) {
      setFields['designUrls.$.url'] = url;
    }

    // ── Record an admin_upload history event when replacing the image ──
    // The uploaded image is already in R2 at a unique key. We record a
    // new `admin_upload` version so the history reflects the replacement,
    // and update `currentVersion` to point to it.
    let uploadVersion: number | undefined;
    if (hasUrl) {
      const uploadedKey = extractR2Key(url) || '';
      const resolved = resolveDesignIdentity(order, productId);
      const identity = resolved
        ? resolved.identity
        : { orderNumber: order.orderNumber, productId, itemIndex: null };
      const actor = {
        userId: auth.user.userId,
        userName: auth.user.name || auth.user.email,
        userEmail: auth.user.email,
        userRole: auth.user.role || 'admin',
      };
      try {
        const uploadResult = await recordUploadEvent({
          order,
          identity,
          designIndex,
          uploadedUrl: url,
          uploadedKey,
          actor,
          operationId: buildUploadOperationId(identity, uploadedKey),
        });
        uploadVersion = uploadResult.newVersion;
        setFields['designUrls.$.currentVersion'] = uploadVersion;
      } catch (uploadError) {
        console.error(
          '[PATCH /api/admin/orders/[id]/designs] recordUploadEvent failed:',
          uploadError,
        );
      }
    }

    const result = await Order.updateOne(
      { _id: id, 'designUrls.productId': productId },
      { $set: setFields },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    try {
      await logActivity({
        action: hasUrl ? 'update' : (nextReviewed ? 'review_design' : 'unreview_design'),
        resource: 'order',
        resourceId: id,
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        details: JSON.stringify({
          orderNumber: order.orderNumber,
          productId,
          ...(hasUrl ? { replacedImage: true } : {}),
          reviewed: nextReviewed,
        }),
      });
    } catch (logError) {
      console.error('[PATCH /api/admin/orders/[id]/designs] logActivity failed:', logError);
    }

    return NextResponse.json({ success: true, data: { productId, reviewed: nextReviewed, url: hasUrl ? url : undefined, version: uploadVersion } });
  } catch (error) {
    console.error('[PATCH /api/admin/orders/[id]/designs]', error);
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to update design' } },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/orders/[id]/designs
 * DELETE /api/admin/orders/[id]/designs?productId={productId}
 *
 * Deletes generated design(s) for an order. The backend owns this
 * end-to-end — it deletes the JPG(s) directly from R2 storage and
 * removes the entry/entries from the order's `designUrls` array. The
 * design app is NOT involved; there is no callback for this.
 *
 * - Without `productId`: deletes ALL designs on the order. Used before
 *   regenerating designs (the admin panel calls DELETE then POST
 *   generate-design).
 * - With `productId`: deletes only that single design. Used by the
 *   "delete design" action on the /order-designs page.
 *
 * Flow:
 *   1. Verify admin auth.
 *   2. Load the order.
 *   3. Resolve which design(s) to remove (all, or the one matching
 *      `productId`).
 *   4. Delete the corresponding R2 objects directly.
 *   5. Remove the entry/entries from the order's designUrls array.
 *   6. Log the action.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess(['orders', 'orderDesigns']);
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const productId = request.nextUrl.searchParams.get('productId');
    // When true, skip creating admin_delete version events. Used by the
    // regenerate flow (DELETE + generate) so we don't end up with both
    // a delete event AND a regenerate event in the history — only the
    // regenerate event should be recorded.
    const skipVersionEvent = request.nextUrl.searchParams.get('skipVersionEvent') === 'true';

    const order = (await Order.findById(id).lean()) as IOrder | null;
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    const designUrls = order.designUrls || [];
    if (designUrls.length === 0) {
      return NextResponse.json({ success: true, data: { deleted: 0 } });
    }

    const toDelete = productId
      ? designUrls.filter((d) => d.productId === productId)
      : designUrls;

    if (productId && toDelete.length === 0) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Design not found' } },
        { status: 404 },
      );
    }

    // Delete the JPG(s) directly from R2 storage
    const keys = toDelete
      .map((d) => extractR2Key(d.url))
      .filter((key): key is string => Boolean(key));

    if (keys.length > 0) {
      try {
        await deleteMultipleR2Objects(keys);
      } catch (r2Error) {
        console.error('[DELETE /api/admin/orders/[id]/designs] R2 deletion failed:', r2Error);
        // Continue anyway — we still remove the entry/entries from the order
      }
    }

    // ── Record admin_delete history events ──────────────────────────────
    // Each deleted design gets a new `admin_delete` version that preserves
    // the last valid snapshot (see `order-history-enhanced.md` §12). The
    // order's designUrls entry is then removed and `currentVersion` becomes
    // null. All immutable history remains available for restore.
    //
    // Skipped when `skipVersionEvent=true` (used by the regenerate flow:
    // DELETE + generate in sequence — only the generate's admin_regenerate
    // event should be recorded, not a delete event).
    //
    // Best-effort: if history recording fails, we still remove the
    // designUrls entry/entries below — the admin's intent (delete the
    // current design) is honored even if the audit trail can't be written.
    if (!skipVersionEvent) {
      const actor = {
        userId: auth.user.userId,
        userName: auth.user.name || auth.user.email,
        userEmail: auth.user.email,
        userRole: auth.user.role || 'admin',
      };

      for (const design of toDelete) {
        try {
          const resolved = resolveDesignIdentity(order, design.productId);
          const identity = resolved
            ? resolved.identity
            : { orderNumber: order.orderNumber, productId: design.productId, itemIndex: null };
          const designIndex = resolved?.designIndex ?? -1;
          await recordDeleteEvent({
            order,
            identity,
            designIndex,
            actor,
            operationId: buildDeleteOperationId(identity),
          });
        } catch (historyError) {
          console.error(
            '[DELETE /api/admin/orders/[id]/designs] recordDeleteEvent failed:',
            historyError,
          );
        }
      }
    }

    // Remove the entry/entries from the order
    if (productId) {
      await Order.updateOne(
        { _id: order._id },
        { $pull: { designUrls: { productId } } },
      );
    } else {
      await Order.updateOne(
        { _id: order._id },
        { $set: { designUrls: [] } },
      );
    }

    // Log the action
    try {
      await logActivity({
        action: 'delete_designs',
        resource: 'order',
        resourceId: String(order._id),
        userId: auth.user.userId,
        userName: auth.user.name,
        userEmail: auth.user.email,
        details: JSON.stringify({
          orderNumber: order.orderNumber,
          deletedCount: toDelete.length,
          productId: productId || undefined,
        }),
      });
    } catch (logError) {
      console.error('[DELETE /api/admin/orders/[id]/designs] logActivity failed:', logError);
    }

    return NextResponse.json({
      success: true,
      data: { deleted: toDelete.length },
    });
  } catch (error) {
    console.error('[DELETE /api/admin/orders/[id]/designs]', error);
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to delete designs' } },
      { status: 500 },
    );
  }
}
