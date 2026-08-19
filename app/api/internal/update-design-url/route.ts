import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';

/**
 * Verify the callback request is from an authorized caller (the design app).
 * Checks the `x-callback-secret` header against the configured secret.
 */
function verifyCallback(request: NextRequest): boolean {
  const secret = process.env.DESIGN_APP_CALLBACK_SECRET;
  if (!secret) return false; // fail-closed if not configured
  const provided = request.headers.get('x-callback-secret');
  if (!provided) return false;
  if (provided.length !== secret.length) return false;
  // Constant-time-ish comparison
  let diff = 0;
  for (let i = 0; i < secret.length; i++) {
    diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * POST /api/internal/update-design-url
 *
 * Internal endpoint called by the design app after it creates a new saved
 * version of an order's design (e.g. after the admin edits + saves in the
 * editor). The design app sends the new immutable archived URL, and the
 * backend updates the order's `designUrls[].url` to point to it — so the
 * admin panel loads the new image instantly.
 *
 * This is NOT an admin endpoint — it's authenticated via the shared
 * `x-callback-secret` header (same secret used by the generate-design
 * callback flow). No user JWT is involved.
 *
 * Body:
 *   {
 *     orderNumber: string,
 *     productId: string,
 *     itemIndex?: number,
 *     url: string,         // the new archived URL
 *     version: number      // the new version number
 *   }
 *
 * Response:
 *   200 — { success: true }
 *   400 — validation error
 *   401 — bad callback secret
 *   404 — order not found
 *
 * See `order-history-enhanced.md` — "every version update creates a new
 * link and replaces the design link on the order".
 */
export async function POST(request: NextRequest) {
  // ── Auth: callback secret ──────────────────────────────────────────
  if (!verifyCallback(request)) {
    return NextResponse.json(
      { success: false, error: { code: 'unauthorized', message: 'Invalid callback secret' } },
      { status: 401 },
    );
  }

  try {
    await connectDB();

    const body = await request.json().catch(() => null);
    const orderNumber = body?.orderNumber;
    const productId = body?.productId;
    const url = body?.url;
    const version = Number(body?.version);

    if (!orderNumber || typeof orderNumber !== 'string') {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing orderNumber' } },
        { status: 400 },
      );
    }
    if (!productId || typeof productId !== 'string') {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing productId' } },
        { status: 400 },
      );
    }
    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Missing url' } },
        { status: 400 },
      );
    }
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_VALIDATION', message: 'Invalid version' } },
        { status: 400 },
      );
    }

    // ── Find the order by orderNumber ──────────────────────────────────
    const order = await Order.findOne({ orderNumber }).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: { code: 'ERR_NOT_FOUND', message: 'Order not found' } },
        { status: 404 },
      );
    }

    // ── Update the matching designUrls entry ───────────────────────────
    // If the entry exists, update its url + currentVersion. If not (e.g.
    // the design was deleted but the admin restored it from history),
    // add a new entry.
    const existingDesign = (order.designUrls || []).find(
      (d) => String(d.productId) === String(productId),
    );

    if (existingDesign) {
      await Order.updateOne(
        { _id: order._id, 'designUrls.productId': productId },
        {
          $set: {
            'designUrls.$.url': url,
            'designUrls.$.currentVersion': version,
            statusUpdateTime: new Date(),
          },
        },
      );
    } else {
      // The design entry was missing (e.g. after a delete). Re-add it
      // pointing to the new version's archived URL.
      await Order.updateOne(
        { _id: order._id },
        {
          $push: {
            designUrls: {
              productId,
              url,
              templateType: 'text',
              createdAt: new Date(),
              reviewed: false,
              currentVersion: version,
            } as unknown as Record<string, unknown>,
          },
          $set: { statusUpdateTime: new Date() },
        },
      );
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'internalError', message: 'Failed to update design URL' } },
      { status: 500 },
    );
  }
}
