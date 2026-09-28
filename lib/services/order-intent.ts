import mongoose from 'mongoose';
import Order, { type IOrder, type OrderStatus } from '@/lib/models/Order';
import Booking from '@/lib/models/Booking';
import Category from '@/lib/models/Categories';
import { normalizeCountryName } from '@/lib/country-visibility';

/**
 * Booking Intent service — see Booking-intent.md.
 *
 * The intent IS the order. Checkout keeps one open unpaid order per
 * customer+basket (enhance-order-createing.md), so an abandoned
 * checkout needs no separate collection — the workflow state lives in
 * `order.intent` and the list reads `orders` directly.
 *
 * `intent.status` values:
 *   (absent)/new — abandoned, nobody has called yet
 *   contacted    — an admin claimed the customer and is talking
 *   refused      — resolved negatively
 *   converted    — paid (or the admin marked it converted)
 *   closed       — the order was cancelled/refunded
 */

export type BookingIntentStatus =
  | 'new'
  | 'contacted'
  | 'refused'
  | 'converted'
  | 'closed';

export const OPEN_INTENT_STATUSES: BookingIntentStatus[] = [
  'new',
  'contacted',
];
const ELIGIBLE_ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'processing',
  'failed',
];
// The customer's LATEST order decides eligibility — a paid-like latest
// order means they bought, regardless of earlier abandoned attempts.
const PAID_LIKE_STATUSES: OrderStatus[] = [
  'paid',
  'partial-paid',
  'completed',
];
const MANUAL_PRODUCT_ID = '__manual_order__';
export const DEFAULT_DELAY_MINUTES = 60;

export interface AdminIdentity {
  adminId: mongoose.Types.ObjectId | string;
  name: string;
  email: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

type OrderLike = Pick<
  IOrder,
  | '_id'
  | 'userId'
  | 'billingData'
  | 'items'
  | 'reservationData'
  | 'createdAt'
  | 'isFreeOrder'
  | 'isSubOrder'
  | 'createdByAdminId'
>;

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function realProductIds(items: IOrder['items'] | undefined): string[] {
  const ids = new Set<string>();
  for (const item of items ?? []) {
    const raw = item.productId;
    if (raw === undefined || raw === null) continue;
    const id = String(raw);
    // Manual-order placeholder must never match across orders.
    if (!id || id === MANUAL_PRODUCT_ID) continue;
    ids.add(id);
  }
  return [...ids];
}

function buildItemsSummary(order: { items?: IOrder['items'] }): string {
  return (order.items ?? [])
    .map((item) => {
      const name = item.productName?.ar || item.productName?.en || 'item';
      return (item.quantity ?? 1) > 1 ? `${item.quantity}x ${name}` : name;
    })
    .join(' + ');
}

/** First non-empty sacrificeFor (مؤدى عنه) entry — for the follow-up message. */
function extractReservationName(order: OrderLike): string | undefined {
  const raw = order.reservationData?.find(
    (field) => field.key === 'sacrificeFor' && field.value?.trim(),
  )?.value;
  if (!raw) return undefined;
  const first = raw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)[0];
  return first || undefined;
}

/**
 * Mongo `$or` that matches every order belonging to the same customer.
 * userId wins, then normalized billing email, then the billing phone as
 * stored (checkout already normalizes it).
 */
function customerIdentityOr(order: {
  userId?: IOrder['userId'];
  billingData?: IOrder['billingData'];
}): Record<string, unknown>[] {
  const or: Record<string, unknown>[] = [];
  if (order.userId) or.push({ userId: order.userId });
  const email = normalizeEmail(order.billingData?.email);
  if (email) or.push({ 'billingData.email': email });
  const phone =
    typeof order.billingData?.phone === 'string'
      ? order.billingData.phone.trim()
      : '';
  if (phone) or.push({ 'billingData.phone': phone });
  return or;
}

/**
 * Predicate for "this order is a live booking intent" — an unpaid
 * website order in an open status whose intent isn't resolved.
 */
function liveIntentMatch(): Record<string, unknown> {
  return {
    $and: [
      { status: { $in: ELIGIBLE_ORDER_STATUSES } },
      {
        $or: [
          { paidAmount: 0 },
          { paidAmount: { $exists: false } },
          { paidAmount: null },
        ],
      },
      { isFreeOrder: { $ne: true } },
      { isSubOrder: { $ne: true } },
      { createdByAdminId: { $exists: false } },
    ],
  };
}

/** Predicate for "the intent is open" (new — incl. absent — or contacted). */
function openIntentMatch(): Record<string, unknown> {
  return {
    $or: [
      { 'intent.status': { $in: OPEN_INTENT_STATUSES } },
      { 'intent.status': { $exists: false } },
    ],
  };
}

// ─── Settings ─────────────────────────────────────────────────────────

export async function getBookingIntentDelayMinutes(): Promise<number> {
  const booking = await Booking.findOne({ key: 'global' })
    .select('bookingIntentDisplayDelayMinutes')
    .lean();
  const value = booking?.bookingIntentDisplayDelayMinutes;
  return typeof value === 'number' && value >= 0
    ? value
    : DEFAULT_DELAY_MINUTES;
}

// ─── List ─────────────────────────────────────────────────────────────

export interface ListIntentsParams {
  status?: BookingIntentStatus | 'all';
  assignedTo?: 'me' | 'none' | string;
  source?: 'manasik' | 'ghadaq';
  search?: string;
  fromDate?: string;
  toDate?: string;
  /** Category id, '__uncategorized__', or 'all'. */
  category?: string;
  /** Billing country (normalized to canonical name before matching). */
  country?: string;
  /** Reservation `intention` value. */
  intention?: string;
  /** Order referralId. */
  referralId?: string;
  page: number;
  limit: number;
  adminId: string;
}

export async function listBookingIntents(params: ListIntentsParams) {
  const delayMinutes = await getBookingIntentDelayMinutes();
  const cutoff = new Date(Date.now() - delayMinutes * 60_000);

  // ── Scope: EVERY customer order counts for the "latest order" test.
  // Sub-orders share their parent's lifecycle and free orders are never
  // purchases — both excluded entirely. Manual orders count: they are
  // real bookings for that customer.
  const scopeMatch = {
    isFreeOrder: { $ne: true },
    isSubOrder: { $ne: true },
  };

  // ── Eligibility: the customer's LATEST order decides everything.
  // A paid-like latest order (paid/partial-paid/completed) means the
  // customer bought — earlier abandoned attempts are just history.
  // The remaining filters apply to the displayed row, which IS the
  // customer's latest order.
  const docFilters: Record<string, unknown>[] = [
    { 'doc.status': { $nin: PAID_LIKE_STATUSES } },
    { 'doc.createdAt': { $lte: cutoff } },
  ];

  let statusClause: Record<string, unknown> | null = null;
  if (params.status && params.status !== 'all') {
    statusClause =
      params.status === 'new'
        ? { 'doc.intent.status': { $in: ['new', null] } }
        : { 'doc.intent.status': params.status };
    docFilters.push(statusClause);
  }

  if (params.assignedTo === 'me') {
    docFilters.push({
      'doc.intent.assignedTo.adminId': new mongoose.Types.ObjectId(
        params.adminId,
      ),
    });
  } else if (params.assignedTo === 'none') {
    docFilters.push({ 'doc.intent.assignedTo': { $exists: false } });
    docFilters.push({ 'doc.intent.status': { $in: ['new', null] } });
  } else if (
    typeof params.assignedTo === 'string' &&
    mongoose.isValidObjectId(params.assignedTo)
  ) {
    docFilters.push({
      'doc.intent.assignedTo.adminId': new mongoose.Types.ObjectId(
        params.assignedTo,
      ),
    });
  }

  if (params.source === 'manasik' || params.source === 'ghadaq') {
    docFilters.push({ 'doc.source': params.source });
  }

  if (params.search) {
    const escaped = params.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = { $regex: escaped, $options: 'i' };
    docFilters.push({
      $or: [
        { 'doc.orderNumber': regex },
        { 'doc.billingData.fullName': regex },
        { 'doc.billingData.email': regex },
        { 'doc.billingData.phone': regex },
        { 'doc.reservationData.value': regex },
      ],
    });
  }

  if (params.fromDate || params.toDate) {
    const range: Record<string, Date> = {};
    if (params.fromDate) range.$gte = new Date(params.fromDate);
    if (params.toDate) {
      const end = new Date(params.toDate);
      end.setHours(23, 59, 59, 999);
      range.$lte = end;
    }
    docFilters.push({ 'doc.createdAt': range });
  }

  if (params.country && params.country !== 'all') {
    // Same convention as execution: stored values are canonical country
    // names — normalize the filter input so a code like 'EG' matches
    // 'Egypt'.
    const normalized = normalizeCountryName(params.country);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    docFilters.push({
      'doc.billingData.country': { $regex: `^${escaped}$`, $options: 'i' },
    });
  }

  // Category: match any item product. items.productId is Mixed — orders
  // store it as string or ObjectId, so send BOTH forms (mirrors the
  // execution route; MongoDB doesn't coerce in $in/$nin).
  if (params.category && params.category !== 'all') {
    let ids: (mongoose.Types.ObjectId | string)[] = [];
    if (params.category === '__uncategorized__') {
      const categorized = await Category.distinct('products');
      ids = categorized.flatMap((p) => {
        const str = String(p);
        return [str, new mongoose.Types.ObjectId(str)];
      });
      docFilters.push({ 'doc.items.productId': { $nin: ids } });
    } else {
      const category = await Category.findById(params.category)
        .select('products')
        .lean();
      ids = ((category?.products as unknown[]) ?? []).flatMap((p) => {
        const str = String(p);
        return [str, new mongoose.Types.ObjectId(str)];
      });
      docFilters.push({ 'doc.items.productId': { $in: ids } });
    }
  }

  if (params.intention && params.intention !== 'all') {
    docFilters.push({
      'doc.reservationData': {
        $elemMatch: { key: 'intention', value: params.intention },
      },
    });
  }

  if (params.referralId) {
    docFilters.push({ 'doc.referralId': params.referralId });
  }

  const query = { $and: docFilters };
  const skip = (params.page - 1) * params.limit;

  // Status counts respect every filter EXCEPT the status one — tab badges.
  // A missing intent subdoc counts as 'new'.
  const countQuery = { $and: docFilters.filter((c) => c !== statusClause) };

  // One row per customer — the LATEST matching order represents them.
  // Identity: userId, else billing email, else billing phone, else the
  // order id itself (unidentifiable orders stay individual rows).
  const customerKeyExpr = {
    $cond: [
      { $gt: [{ $strLenCP: { $ifNull: [{ $toString: '$userId' }, ''] } }, 0] },
      { $toString: '$userId' },
      {
        $cond: [
          {
            $gt: [
              { $strLenCP: { $ifNull: ['$billingData.email', ''] } },
              0,
            ],
          },
          '$billingData.email',
          {
            $cond: [
              {
                $gt: [
                  { $strLenCP: { $ifNull: ['$billingData.phone', ''] } },
                  0,
                ],
              },
              '$billingData.phone',
              { $toString: '$_id' },
            ],
          },
        ],
      },
    ],
  };

  // Per-order "open intent" flag — powers the "Claim N" badge.
  const openIntentExpr = {
    $and: [
      { $in: ['$status', ELIGIBLE_ORDER_STATUSES] },
      { $lte: [{ $ifNull: ['$paidAmount', 0] }, 0] },
      {
        $or: [
          { $in: ['$intent.status', OPEN_INTENT_STATUSES] },
          { $eq: [{ $ifNull: ['$intent.status', null] }, null] },
        ],
      },
    ],
  };

  const groupStage = {
    $group: {
      _id: customerKeyExpr,
      doc: { $first: '$$ROOT' },
      openIntentCount: { $sum: { $cond: [openIntentExpr, 1, 0] } },
      orderCount: { $sum: 1 },
    },
  };

  const [listResult, countsAgg, assigneesAgg] = await Promise.all([
    Order.aggregate([
      { $match: scopeMatch },
      { $sort: { createdAt: -1 } },
      groupStage,
      { $match: query },
      {
        $facet: {
          docs: [{ $skip: skip }, { $limit: params.limit }],
          total: [{ $count: 'n' }],
        },
      },
    ]),
    // Per-customer status counts — each customer counts once, under the
    // status of their latest order.
    Order.aggregate([
      { $match: scopeMatch },
      { $sort: { createdAt: -1 } },
      { $group: { _id: customerKeyExpr, doc: { $first: '$$ROOT' } } },
      { $match: countQuery },
      {
        $group: {
          _id: { $ifNull: ['$doc.intent.status', 'new'] },
          count: { $sum: 1 },
        },
      },
    ]),
    // Distinct assignees — powers the "assigned to" filter dropdown.
    Order.aggregate([
      { $match: { 'intent.assignedTo.adminId': { $exists: true } } },
      {
        $group: {
          _id: '$intent.assignedTo.adminId',
          name: { $first: '$intent.assignedTo.name' },
        },
      },
    ]),
  ]);

  const grouped = (listResult[0]?.docs ?? []) as Array<{
    doc: IOrder;
    openIntentCount: number;
    orderCount: number;
  }>;
  const total = Number(listResult[0]?.total?.[0]?.n ?? 0);

  const statusCounts: Record<string, number> = {
    all: 0,
    new: 0,
    contacted: 0,
    refused: 0,
    converted: 0,
    closed: 0,
  };
  for (const row of countsAgg as Array<{ _id: string; count: number }>) {
    if (row._id in statusCounts) statusCounts[row._id] = row.count;
    statusCounts.all += row.count;
  }

  return {
    intents: grouped.map(({ doc: order, openIntentCount, orderCount }) => {
      const paymentTries =
        order.paymentAttempts?.length ?? order.payments?.length ?? 0;
      return {
        _id: String(order._id),
        orderId: String(order._id),
        orderNumber: order.orderNumber ?? '',
        customer: {
          fullName: order.billingData?.fullName ?? '',
          email: order.billingData?.email ?? '',
          phone: order.billingData?.phone ?? '',
          country: order.billingData?.country ?? '',
        },
        items: (order.items ?? []).map((item) => ({
          productName: {
            ar: item.productName?.ar ?? '',
            en: item.productName?.en ?? '',
          },
          quantity: item.quantity ?? 1,
        })),
        itemsSummary: buildItemsSummary(order),
        reservationName: extractReservationName(order),
        amount: order.fullAmount ?? order.totalAmount ?? 0,
        currency: order.currency ?? 'EGP',
        source: order.source,
        paymentAttemptCount: paymentTries,
        // How many matching orders this customer has — claim/resolve act
        // on all of them even though only the latest is displayed.
        attemptCount: orderCount,
        orderCreatedAt: order.createdAt,
        status: order.intent?.status ?? 'new',
        assignedTo: order.intent?.assignedTo
          ? {
            adminId: String(order.intent.assignedTo.adminId),
            name: order.intent.assignedTo.name,
            email: order.intent.assignedTo.email,
          }
          : undefined,
        assignedAt: order.intent?.assignedAt,
        resolvedAt: order.intent?.resolvedAt,
        resolvedBy: order.intent?.resolvedBy,
        autoReason: order.intent?.autoReason,
        note: order.intent?.note,
        openIntentCount,
      };
    }),
    statusCounts,
    assignedAdmins: (
      assigneesAgg as Array<{ _id: unknown; name: string }>
    )
      .filter((a) => a._id != null)
      .map((a) => ({ adminId: String(a._id), name: a.name ?? '' })),
    pagination: {
      currentPage: params.page,
      totalPages: Math.ceil(total / params.limit),
      totalIntents: total,
      hasNextPage: params.page * params.limit < total,
      hasPrevPage: params.page > 1,
    },
    displayDelayMinutes: delayMinutes,
  };
}

// ─── Claim / release / resolve / reopen ───────────────────────────────

export type ClaimResult =
  | { ok: true; claimedCount: number }
  | { ok: false; reason: 'not_found' | 'conflict'; claimedBy?: AdminIdentity };

/**
 * Claim = assign THIS order (the customer's latest) to the admin.
 * Previous orders of the customer are skipped — the list only ever
 * shows the latest one. Customer-wide exclusivity still holds: another
 * admin holding any open intent of this customer blocks the claim.
 */
export async function claimCustomer(
  admin: AdminIdentity,
  intentId: string,
): Promise<ClaimResult> {
  const order = await Order.findById(intentId)
    .select('userId billingData intent')
    .lean();
  if (!order) return { ok: false, reason: 'not_found' };

  const adminId = new mongoose.Types.ObjectId(String(admin.adminId));
  const identOr = customerIdentityOr(order);

  // Conflict: another admin holds an open intent of this customer.
  const conflict = identOr.length
    ? await Order.findOne({
      $and: [
        { $or: identOr },
        liveIntentMatch(),
        {
          'intent.assignedTo.adminId': { $exists: true, $ne: adminId },
        },
      ],
    })
      .select('intent.assignedTo')
      .lean()
    : null;

  if (conflict?.intent?.assignedTo) {
    return {
      ok: false,
      reason: 'conflict',
      claimedBy: {
        adminId: conflict.intent.assignedTo.adminId,
        name: conflict.intent.assignedTo.name,
        email: conflict.intent.assignedTo.email,
      },
    };
  }

  // Claim ONLY this order — guarded so a concurrent claim can't be
  // silently overwritten.
  const result = await Order.updateOne(
    {
      _id: order._id,
      $or: [
        { 'intent.assignedTo': { $exists: false } },
        { 'intent.assignedTo.adminId': adminId },
      ],
    },
    {
      $set: {
        'intent.status': 'contacted',
        'intent.assignedTo': {
          adminId,
          name: admin.name,
          email: admin.email,
        },
        'intent.assignedAt': new Date(),
      },
    },
  );

  if (result.modifiedCount === 0) {
    const holder = await Order.findById(order._id)
      .select('intent.assignedTo')
      .lean();
    if (holder?.intent?.assignedTo) {
      return {
        ok: false,
        reason: 'conflict',
        claimedBy: {
          adminId: holder.intent.assignedTo.adminId,
          name: holder.intent.assignedTo.name,
          email: holder.intent.assignedTo.email,
        },
      };
    }
  }

  return { ok: true, claimedCount: result.modifiedCount };
}

export type ReleaseResult =
  | { ok: true; releasedCount: number }
  | { ok: false; reason: 'not_found' | 'not_assigned' | 'not_owner' };

/** Customer-level release — the whole claim is given up at once. */
export async function releaseCustomer(
  admin: AdminIdentity,
  intentId: string,
): Promise<ReleaseResult> {
  const order = await Order.findById(intentId)
    .select('userId billingData intent')
    .lean();
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.intent?.status !== 'contacted' || !order.intent.assignedTo) {
    return { ok: false, reason: 'not_assigned' };
  }
  if (String(order.intent.assignedTo.adminId) !== String(admin.adminId)) {
    return { ok: false, reason: 'not_owner' };
  }

  const identOr = customerIdentityOr(order);
  const result = await Order.updateMany(
    {
      $and: [
        { $or: identOr },
        {
          'intent.status': 'contacted',
          'intent.assignedTo.adminId': order.intent.assignedTo.adminId,
        },
      ],
    },
    {
      $set: { 'intent.status': 'new' },
      $unset: { 'intent.assignedTo': '', 'intent.assignedAt': '' },
    },
  );

  return { ok: true, releasedCount: result.modifiedCount };
}

export type ResolveOutcome = 'refused' | 'converted';
export type ResolveResult =
  | { ok: true; resolvedCount: number }
  | { ok: false; reason: 'not_found' | 'not_contacted' | 'not_owner' };

export async function resolveIntent(
  admin: AdminIdentity,
  intentId: string,
  outcome: ResolveOutcome,
  note?: string,
  cascade = false,
): Promise<ResolveResult> {
  const order = await Order.findById(intentId)
    .select('userId billingData intent')
    .lean();
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.intent?.status !== 'contacted') {
    return { ok: false, reason: 'not_contacted' };
  }
  if (String(order.intent.assignedTo?.adminId) !== String(admin.adminId)) {
    return { ok: false, reason: 'not_owner' };
  }

  const adminId = new mongoose.Types.ObjectId(String(admin.adminId));
  const scope = cascade
    ? {
      $and: [
        { $or: customerIdentityOr(order) },
        {
          'intent.status': 'contacted' as const,
          'intent.assignedTo.adminId': adminId,
        },
      ],
    }
    : { _id: order._id };

  const result = await Order.updateMany(scope, {
    $set: {
      'intent.status': outcome,
      'intent.resolvedAt': new Date(),
      'intent.resolvedBy': 'admin',
      'intent.resolvedByAdmin': { adminId, name: admin.name },
      ...(note ? { 'intent.note': note } : {}),
    },
  });

  return { ok: true, resolvedCount: result.modifiedCount };
}

export type ReopenResult =
  | { ok: true }
  | {
    ok: false;
    reason: 'not_found' | 'not_refused' | 'conflict';
    claimedBy?: AdminIdentity;
  };

export async function reopenIntent(
  admin: AdminIdentity,
  intentId: string,
): Promise<ReopenResult> {
  const order = await Order.findById(intentId)
    .select('userId billingData items intent')
    .lean();
  if (!order) return { ok: false, reason: 'not_found' };
  if (order.intent?.status !== 'refused') {
    return { ok: false, reason: 'not_refused' };
  }

  // Reopening must not collide with another open intent order of the
  // same customer for an overlapping product (e.g. a newer checkout).
  const productIds = realProductIds(order.items);
  if (productIds.length > 0) {
    const conflict = await Order.findOne({
      $and: [
        { _id: { $ne: order._id } },
        { $or: customerIdentityOr(order) },
        liveIntentMatch(),
        openIntentMatch(),
        { 'items.productId': { $in: productIds } },
      ],
    })
      .select('intent.assignedTo')
      .lean();
    if (conflict) {
      return {
        ok: false,
        reason: 'conflict',
        claimedBy: conflict.intent?.assignedTo
          ? {
            adminId: conflict.intent.assignedTo.adminId,
            name: conflict.intent.assignedTo.name,
            email: conflict.intent.assignedTo.email,
          }
          : undefined,
      };
    }
  }

  const adminId = new mongoose.Types.ObjectId(String(admin.adminId));
  await Order.updateOne(
    { _id: order._id, 'intent.status': 'refused' },
    {
      $set: {
        'intent.status': 'contacted',
        'intent.assignedTo': {
          adminId,
          name: admin.name,
          email: admin.email,
        },
        'intent.assignedAt': new Date(),
      },
      $unset: {
        'intent.resolvedAt': '',
        'intent.resolvedBy': '',
        'intent.resolvedByAdmin': '',
        'intent.autoReason': '',
      },
    },
  );

  return { ok: true };
}

// ─── Auto-resolution on order terminal states ─────────────────────────

/**
 * Call wherever an order reaches a terminal state. `paid` covers
 * paid/partial-paid/completed; `closed` covers cancelled/refunded/deleted.
 * Fire-and-forget — callers wrap in .catch().
 */
export async function syncIntentsOnOrderTerminal(
  order: OrderLike,
  outcome: 'paid' | 'closed',
): Promise<void> {
  // Website orders only — manual, sub-order, and free orders are never
  // booking intents.
  if (order.isFreeOrder || order.isSubOrder || order.createdByAdminId) return;

  const orderId = String(order._id);
  const now = new Date();

  // An order only "is" an intent if it carried workflow state or sat
  // unpaid past the display delay (the delay is the intent boundary —
  // a checkout paid within it never surfaced as an intent).
  const delayMinutes = await getBookingIntentDelayMinutes();
  const wasListable =
    !order.createdAt ||
    now.getTime() - new Date(order.createdAt).getTime() >
    delayMinutes * 60_000;
  const untouchedOrOpen: Record<string, unknown> = wasListable
    ? {
      $or: [
        { 'intent.status': { $in: [...OPEN_INTENT_STATUSES, 'refused'] } },
        { 'intent.status': { $exists: false } },
      ],
    }
    : { 'intent.status': { $in: [...OPEN_INTENT_STATUSES, 'refused'] } };

  if (outcome === 'paid') {
    await Order.updateOne(
      {
        _id: orderId,
        ...untouchedOrOpen,
      },
      {
        $set: {
          'intent.status': 'converted',
          'intent.resolvedAt': now,
          'intent.resolvedBy': 'auto',
          'intent.autoReason': 'paid',
        },
      },
    );

    // Suppress other open intent orders of the same customer sharing a
    // product and created before this purchase.
    const identOr = customerIdentityOr(order);
    const productIds = realProductIds(order.items);
    if (identOr.length > 0 && productIds.length > 0) {
      await Order.updateMany(
        {
          $and: [
            { _id: { $ne: order._id } },
            { $or: identOr },
            liveIntentMatch(),
            openIntentMatch(),
            { 'items.productId': { $in: productIds } },
            { createdAt: { $lt: order.createdAt ?? now } },
          ],
        },
        {
          $set: {
            'intent.status': 'converted',
            'intent.resolvedAt': now,
            'intent.resolvedBy': 'auto',
            'intent.autoReason': 'purchased_elsewhere',
          },
        },
      );
    }
    return;
  }

  // outcome === 'closed' — the order was cancelled/refunded/deleted.
  // Only closes an intent that was actually open or refused.
  await Order.updateOne(
    {
      _id: orderId,
      ...untouchedOrOpen,
    },
    {
      $set: {
        'intent.status': 'closed',
        'intent.resolvedAt': now,
        'intent.resolvedBy': 'auto',
        'intent.autoReason': 'cancelled',
      },
    },
  );
}

// ─── Stats (customers permission) ─────────────────────────────────────

export async function getBookingIntentStats(
  fromDate?: string,
  toDate?: string,
) {
  const range: Record<string, Date> = {};
  if (fromDate) range.$gte = new Date(fromDate);
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    range.$lte = end;
  }
  const inRange = Object.keys(range).length > 0;

  const claimedMatch: Record<string, unknown> = {
    'intent.assignedTo.adminId': { $exists: true },
  };
  if (inRange) claimedMatch['intent.assignedAt'] = range;

  const resolvedMatch: Record<string, unknown> = {
    'intent.status': { $in: ['converted', 'refused'] },
    'intent.resolvedAt': { $exists: true },
  };
  if (inRange) resolvedMatch['intent.resolvedAt'] = range;

  // claimed → by intent.assignedTo.adminId (assignedAt in range)
  // converted → credited to the assigned admin (resolvedAt in range)
  // refused → credited to the resolving admin (resolvedAt in range)
  const [claimedRows, contactedRows, convertedRows, refusedRows] =
    await Promise.all([
      Order.aggregate([
        { $match: claimedMatch },
        {
          $group: {
            _id: '$intent.assignedTo.adminId',
            name: { $first: '$intent.assignedTo.name' },
            email: { $first: '$intent.assignedTo.email' },
            claimed: { $sum: 1 },
          },
        },
      ]),
      // Currently talking — live state, no date range.
      Order.aggregate([
        {
          $match: {
            'intent.status': 'contacted',
            'intent.assignedTo.adminId': { $exists: true },
          },
        },
        {
          $group: {
            _id: '$intent.assignedTo.adminId',
            name: { $first: '$intent.assignedTo.name' },
            contacted: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: { ...resolvedMatch, 'intent.status': 'converted' } },
        {
          $group: {
            _id: '$intent.assignedTo.adminId',
            name: { $first: '$intent.assignedTo.name' },
            email: { $first: '$intent.assignedTo.email' },
            converted: { $sum: 1 },
          },
        },
      ]),
      Order.aggregate([
        { $match: { ...resolvedMatch, 'intent.status': 'refused' } },
        {
          $group: {
            _id: '$intent.resolvedByAdmin.adminId',
            name: { $first: '$intent.resolvedByAdmin.name' },
            refused: { $sum: 1 },
          },
        },
      ]),
    ]);

  const byAdmin = new Map<
    string,
    {
      adminId: string;
      name: string;
      email: string;
      claimed: number;
      contacted: number;
      converted: number;
      refused: number;
      conversionRate: number;
    }
  >();

  const ensure = (id: string) => {
    let row = byAdmin.get(id);
    if (!row) {
      row = {
        adminId: id,
        name: '',
        email: '',
        claimed: 0,
        contacted: 0,
        converted: 0,
        refused: 0,
        conversionRate: 0,
      };
      byAdmin.set(id, row);
    }
    return row;
  };

  for (const r of claimedRows as Array<Record<string, unknown>>) {
    const row = ensure(String(r._id));
    row.name = String(r.name ?? '');
    row.email = String(r.email ?? '');
    row.claimed = Number(r.claimed ?? 0);
  }
  for (const r of contactedRows as Array<Record<string, unknown>>) {
    if (r._id == null) continue;
    const row = ensure(String(r._id));
    row.name = row.name || String(r.name ?? '');
    row.contacted = Number(r.contacted ?? 0);
  }
  for (const r of convertedRows as Array<Record<string, unknown>>) {
    if (r._id == null) continue;
    const row = ensure(String(r._id));
    row.name = row.name || String(r.name ?? '');
    row.email = row.email || String(r.email ?? '');
    row.converted = Number(r.converted ?? 0);
  }
  for (const r of refusedRows as Array<Record<string, unknown>>) {
    if (r._id == null) continue;
    const row = ensure(String(r._id));
    row.name = row.name || String(r.name ?? '');
    row.refused = Number(r.refused ?? 0);
  }

  const admins = [...byAdmin.values()].map((row) => ({
    ...row,
    // Resolved-outcome rate: converted share of this admin's refusals +
    // conversions in range — never exceeds 100%.
    conversionRate:
      row.converted + row.refused > 0
        ? Math.round((row.converted / (row.converted + row.refused)) * 1000) /
        10
        : 0,
  }));

  admins.sort((a, b) => b.converted - a.converted || b.claimed - a.claimed);
  return { admins };
}
