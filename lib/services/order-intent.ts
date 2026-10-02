import mongoose from 'mongoose';
import Order, { type IOrder, type OrderStatus } from '@/lib/models/Order';
import AdminAchievement from '@/lib/models/AdminAchievement';
import Booking from '@/lib/models/Booking';
import Category from '@/lib/models/Categories';
import { normalizeCountryName } from '@/lib/country-visibility';

// Disk-sort safety net — sorting/grouping the whole orders collection
// exceeds MongoDB's 32MB in-memory limit (error 292) as data grows;
// allowDiskUse opts into disk-based sorting so it can never throw.
const ordersAgg = (pipeline: mongoose.PipelineStage[]) =>
  Order.aggregate(pipeline, { allowDiskUse: true });

/**
 * Booking Intent service — see Booking-intent.md.
 *
 * Orders carry NO workflow state. Talking/conversion state lives in the
 * `adminachievements` collection — one record per (admin, customer):
 * the first WhatsApp click upserts it to 'talking', and any paid-like
 * order of that customer flips it to 'paid' (the talking admin gets
 * the point).
 *
 * The list still reads `orders` grouped by customer — the status/owner
 * of each row is derived by joining achievements on customerKey.
 */

export type BookingIntentStatus = 'new' | 'contacted' | 'converted';

// Open/failed orders are live intents. A paid-like latest order keeps
// the customer on the list only when an achievement exists (someone
// talked to them) — the row then shows 'converted' for the overview.
// Cancelled/refunded latest orders never render (an admin closed it,
// not an abandoned checkout).
const ELIGIBLE_ORDER_STATUSES: OrderStatus[] = [
  'pending',
  'processing',
  'failed',
];
const PAID_LIKE_ORDER_STATUSES: OrderStatus[] = [
  'paid',
  'partial-paid',
  'completed',
];
export const DEFAULT_DELAY_MINUTES = 60;

export interface AdminIdentity {
  adminId: mongoose.Types.ObjectId | string;
  name: string;
  email: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────

type OrderLike = Pick<
  IOrder,
  '_id' | 'userId' | 'billingData' | 'createdAt' | 'isFreeOrder'
>;

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * The customer identity the list groups by — userId, else billing
 * email, else billing phone, else the order id (unidentifiable orders
 * stay individual). Achievement `customerKey` stores this exact value.
 */
function customerKeyFor(order: OrderLike): string {
  if (order.userId) return String(order.userId);
  const email = normalizeEmail(order.billingData?.email);
  if (email) return email;
  const phone =
    typeof order.billingData?.phone === 'string'
      ? order.billingData.phone.trim()
      : '';
  if (phone) return phone;
  return String(order._id);
}

/**
 * EVERY identity an order carries — used by the paid hook so a talking
 * record keyed by any of them still converts (e.g. the abandoned order
 * had no userId but the paid one does).
 */
function customerKeysFor(order: OrderLike): string[] {
  const keys = new Set<string>();
  if (order.userId) keys.add(String(order.userId));
  const email = normalizeEmail(order.billingData?.email);
  if (email) keys.add(email);
  const phone =
    typeof order.billingData?.phone === 'string'
      ? order.billingData.phone.trim()
      : '';
  if (phone) keys.add(phone);
  return [...keys];
}

/**
 * Strip heavy/gateway-internal fields before sending the order doc to
 * the admin panel — the row only needs display fields (reservationData,
 * items, amounts, whatsapp state).
 */
function sanitizeIntentOrder(order: IOrder): Record<string, unknown> {
  const sanitized = { ...(order as unknown as Record<string, unknown>) };
  delete sanitized.easykashRef;
  delete sanitized.easykashProductCode;
  delete sanitized.easykashVoucher;
  delete sanitized.easykashResponse;
  delete sanitized.payments;
  delete sanitized.paymentAttempts;
  delete sanitized.internalNotes;
  return sanitized;
}

/** First non-empty sacrificeFor (مؤدى عنه) entry — for the follow-up message. */
function extractReservationName(order: OrderLike & {
  reservationData?: IOrder['reservationData'];
}): string | undefined {
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

/** Every filter the booking-intent page can apply — shared by the list
 * and the admin stats so both always describe the SAME customer set. */
export interface IntentFilterParams {
  status?: BookingIntentStatus | 'all';
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
}

export interface ListIntentsParams extends IntentFilterParams {
  /** Column sort — currently only 'amount' is sortable. */
  sortBy?: 'amount';
  sortOrder?: 'asc' | 'desc';
  page: number;
  limit: number;
}

/**
 * Pipeline stages that group orders into one row per customer and
 * derive the talking status from `adminachievements`.
 * Group `_id` = the customerKey the achievements are keyed by.
 */
function intentPipelineStages(): mongoose.PipelineStage[] {
  // Same precedence as customerKeyFor: userId → email → phone → _id.
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

  return [
    {
      $group: {
        _id: customerKeyExpr,
        doc: { $first: '$$ROOT' },
      },
    },
    // Talking / paid state comes from the achievements collection.
    {
      $lookup: {
        from: 'adminachievements',
        let: { ck: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$customerKey', '$$ck'] } } },
          {
            $project: {
              status: 1,
              adminId: 1,
              adminName: 1,
              adminEmail: 1,
              claimedAt: 1,
              paidAt: 1,
            },
          },
        ],
        as: 'ach',
      },
    },
    {
      $addFields: {
        talkingAch: {
          $arrayElemAt: [
            {
              $filter: {
                input: '$ach',
                as: 'a',
                cond: { $eq: ['$$a.status', 'talking'] },
              },
            },
            0,
          ],
        },
        paidAch: {
          $arrayElemAt: [
            {
              $filter: {
                input: '$ach',
                as: 'a',
                cond: { $eq: ['$$a.status', 'paid'] },
              },
            },
            0,
          ],
        },
        // Kept through the $match (a paid-like latest order only
        // renders when the customer has an achievement) — harmless
        // extra field on the grouped docs.
        hasAch: { $gt: [{ $size: '$ach' }, 0] },
      },
    },
    {
      $addFields: {
        intentStatus: {
          // A paid-like latest order = success → 'converted', even if
          // the achievement hasn't flipped to 'paid' yet.
          $cond: [
            { $in: ['$doc.status', PAID_LIKE_ORDER_STATUSES] },
            'converted',
            {
              $cond: [
                { $gt: ['$talkingAch', null] },
                'contacted',
                { $cond: [{ $gt: ['$paidAch', null] }, 'converted', 'new'] },
              ],
            },
          ],
        },
      },
    },
    // Keep the docs lean — the raw array isn't needed downstream.
    // `paidAch` stays: the stats use it as the owner of converted rows.
    { $project: { ach: 0 } },
  ];
}

// ── Scope: EVERY customer order counts for the "latest order" test.
// Sub-orders share their parent's lifecycle and free orders are never
// purchases — both excluded entirely. Manual orders count: they are
// real bookings for that customer.
const SCOPE_MATCH = {
  isFreeOrder: { $ne: true },
  isSubOrder: { $ne: true },
};

/**
 * Post-grouping $match clauses — eligibility + every page filter.
 * Shared by the list and the admin stats so both describe the SAME
 * customer set.
 */
async function buildIntentDocFilters(
  params: IntentFilterParams,
  cutoff: Date,
): Promise<{
  docFilters: Record<string, unknown>[];
  statusClause: Record<string, unknown> | null;
}> {
  // ── Eligibility: the customer's LATEST order decides everything.
  // Open/failed → live intent (delay-gated so fresh orders get time
  // to complete). Paid-like → keep the row for the overview only when
  // the customer has an achievement (someone engaged them), shown as
  // 'converted' — and bypass the delay so a success shows instantly.
  // Cancelled/refunded → never render (closed, not abandoned).
  const docFilters: Record<string, unknown>[] = [
    {
      $or: [
        {
          'doc.status': { $in: ELIGIBLE_ORDER_STATUSES },
          'doc.createdAt': { $lte: cutoff },
        },
        {
          'doc.status': { $in: PAID_LIKE_ORDER_STATUSES },
          hasAch: true,
        },
      ],
    },
  ];

  let statusClause: Record<string, unknown> | null = null;
  if (params.status && params.status !== 'all') {
    // `intentStatus` is derived by the pipeline (see intentPipelineStages).
    statusClause = { intentStatus: params.status };
    docFilters.push(statusClause);
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

  return { docFilters, statusClause };
}

export async function listBookingIntents(params: ListIntentsParams) {
  const delayMinutes = await getBookingIntentDelayMinutes();
  const cutoff = new Date(Date.now() - delayMinutes * 60_000);
  const { docFilters, statusClause } = await buildIntentDocFilters(
    params,
    cutoff,
  );

  const query = { $and: docFilters };
  const skip = (params.page - 1) * params.limit;

  // Row ordering — applied AFTER grouping so it sorts customers, not
  // orders.
  // Default (the work queue): most payment attempts first — the hottest
  // leads — then oldest `updatedAt` first so untouched customers rise
  // to the top (+ _id tiebreak). 'amount' sorts by the displayed value
  // (fullAmount with totalAmount fallback — same expression the row
  // emits).
  const sortDocs: mongoose.PipelineStage.FacetPipelineStage[] =
    params.sortBy === 'amount'
      ? [
        {
          $addFields: {
            sortAmt: { $ifNull: ['$doc.fullAmount', '$doc.totalAmount'] },
          },
        },
        {
          $sort: {
            sortAmt: params.sortOrder === 'asc' ? 1 : -1,
            'doc._id': -1,
          },
        },
      ]
      : [
        {
          $addFields: {
            // paymentAttempts?.length ?? payments?.length — same as the
            // row's paymentAttemptCount.
            sortTries: {
              $size: {
                $ifNull: [
                  '$doc.paymentAttempts',
                  { $ifNull: ['$doc.payments', []] },
                ],
              },
            },
          },
        },
        {
          $sort: {
            sortTries: -1,
            'doc.updatedAt': 1,
            'doc._id': -1,
          },
        },
      ];

  // Status counts respect every filter EXCEPT the status one — tab badges.
  const countQuery = { $and: docFilters.filter((c) => c !== statusClause) };

  // One row per customer — the LATEST matching order represents them.
  const pipelineStages = intentPipelineStages();

  const [listResult, countsAgg] = await Promise.all([
    ordersAgg([
      { $match: SCOPE_MATCH },
      { $sort: { createdAt: -1, _id: -1 } },
      ...pipelineStages,
      { $match: query },
      {
        $facet: {
          docs: [...sortDocs, { $skip: skip }, { $limit: params.limit }],
          total: [{ $count: 'n' }],
        },
      },
    ]),
    // Per-customer status counts — each customer counts once, under the
    // derived status of their latest order.
    ordersAgg([
      { $match: SCOPE_MATCH },
      { $sort: { createdAt: -1, _id: -1 } },
      ...pipelineStages,
      { $match: countQuery },
      {
        $group: {
          _id: '$intentStatus',
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const grouped = (listResult[0]?.docs ?? []) as Array<{
    doc: IOrder;
    intentStatus: BookingIntentStatus;
    talkingAch?: {
      adminId: mongoose.Types.ObjectId;
      adminName: string;
      adminEmail: string;
      claimedAt: Date;
    };
  }>;
  const total = Number(listResult[0]?.total?.[0]?.n ?? 0);

  const statusCounts: Record<string, number> = {
    all: 0,
    new: 0,
    contacted: 0,
    converted: 0,
  };
  for (const row of countsAgg as Array<{ _id: string; count: number }>) {
    if (row._id in statusCounts) statusCounts[row._id] = row.count;
    statusCounts.all += row.count;
  }

  return {
    intents: grouped.map(({ doc: order, intentStatus, talkingAch }) => {
      const paymentTries =
        order.paymentAttempts?.length ?? order.payments?.length ?? 0;
      return {
        _id: String(order._id),
        orderId: String(order._id),
        orderNumber: order.orderNumber ?? '',
        // Full order doc (sanitized) — the admin panel renders
        // execution-style cells straight from it.
        order: sanitizeIntentOrder(order),
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
        reservationName: extractReservationName(order),
        amount: order.fullAmount ?? order.totalAmount ?? 0,
        currency: order.currency ?? 'EGP',
        source: order.source,
        paymentAttemptCount: paymentTries,
        orderCreatedAt: order.createdAt,
        status: intentStatus,
        assignedTo: talkingAch
          ? {
            adminId: String(talkingAch.adminId),
            name: talkingAch.adminName,
            email: talkingAch.adminEmail,
          }
          : undefined,
        assignedAt: talkingAch?.claimedAt,
      };
    }),
    statusCounts,
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

// ─── Claim ────────────────────────────────────────────────────────────

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'conflict'; claimedBy?: AdminIdentity };

/**
 * Claim = upsert the (admin, customerKey) achievement to 'talking'.
 * The first WhatsApp click IS the claim — no separate button.
 * Exclusive while talking: another admin's 'talking' record on the
 * same customerKey → 409 with their identity.
 */
export async function claimCustomer(
  admin: AdminIdentity,
  orderId: string,
): Promise<ClaimResult> {
  const order = await Order.findById(orderId)
    .select('userId billingData')
    .lean();
  if (!order) return { ok: false, reason: 'not_found' };

  const customerKey = customerKeyFor(order);
  const adminId = new mongoose.Types.ObjectId(String(admin.adminId));

  // Conflict: another admin is already talking to this customer.
  const conflict = await AdminAchievement.findOne({
    customerKey,
    status: 'talking',
    adminId: { $ne: adminId },
  })
    .select('adminId adminName adminEmail')
    .lean();

  if (conflict) {
    return {
      ok: false,
      reason: 'conflict',
      claimedBy: {
        adminId: conflict.adminId,
        name: conflict.adminName,
        email: conflict.adminEmail,
      },
    };
  }

  // Upsert the (admin, customer) record — a previous 'paid' record for
  // the same admin re-claims to 'talking' (new conversation).
  await AdminAchievement.updateOne(
    { adminId, customerKey },
    {
      $set: {
        status: 'talking',
        adminName: admin.name,
        adminEmail: admin.email,
        orderId: order._id,
        claimedAt: new Date(),
      },
      $unset: { paidAt: '' },
    },
    { upsert: true },
  );

  return { ok: true };
}

// ─── Paid hook ────────────────────────────────────────────────────────

/**
 * Call wherever an order reaches a paid-like state
 * (paid/partial-paid/completed). Every 'talking' achievement matching
 * the customer's identity flips to 'paid' — the talking admin gets the
 * point. Fire-and-forget — callers wrap in .catch().
 */
export async function syncAchievementOnOrderPaid(
  order: OrderLike,
): Promise<void> {
  // Free orders are never purchases.
  if (order.isFreeOrder) return;
  const keys = customerKeysFor(order);
  if (keys.length === 0) return;

  await AdminAchievement.updateMany(
    { customerKey: { $in: keys }, status: 'talking' },
    {
      $set: {
        status: 'paid',
        paidAt: new Date(),
        orderId: order._id,
      },
    },
  );
}

// ─── Stats (achievements action permission) ───────────────────────────

/**
 * Per-admin performance over the EXACT customer set the list shows —
 * same scope, eligibility, delay gating, and every page filter
 * (including the status tab). Stats are never derived from the
 * achievements collection globally: an achievement only counts when
 * its customer is actually displayed.
 *
 * Per displayed row, the OWNING achievement is `talkingAch` (live
 * claim) falling back to `paidAch` (converted rows):
 *   claimed   → owner achievement's `claimedAt` inside the date range
 *               (all of them when no range is set)
 *   contacted → rows with a live talking achievement
 *   converted → rows shown as converted (paid-like latest order or a
 *               paid achievement)
 * Each row counts once, under one admin — the same way it renders once.
 */
export async function getBookingIntentStats(params: IntentFilterParams) {
  const delayMinutes = await getBookingIntentDelayMinutes();
  const cutoff = new Date(Date.now() - delayMinutes * 60_000);
  const { docFilters } = await buildIntentDocFilters(params, cutoff);

  const rows = (await ordersAgg([
    { $match: SCOPE_MATCH },
    { $sort: { createdAt: -1, _id: -1 } },
    ...intentPipelineStages(),
    { $match: { $and: docFilters } },
    {
      $project: {
        _id: 0,
        intentStatus: 1,
        talkingAch: 1,
        paidAch: 1,
      },
    },
  ])) as Array<{
    intentStatus: BookingIntentStatus;
    talkingAch?: AchievementRef | null;
    paidAch?: AchievementRef | null;
  }>;

  const hasRange = Boolean(params.fromDate || params.toDate);
  const from = params.fromDate ? new Date(params.fromDate).getTime() : null;
  const to = params.toDate
    ? (() => {
      const end = new Date(params.toDate);
      end.setHours(23, 59, 59, 999);
      return end.getTime();
    })()
    : null;
  const claimedInRange = (claimedAt?: Date | string | null) => {
    if (!claimedAt) return false;
    if (!hasRange) return true;
    const t = new Date(claimedAt).getTime();
    return (!from || t >= from) && (!to || t <= to);
  };

  const byAdmin = new Map<
    string,
    {
      adminId: string;
      name: string;
      email: string;
      claimed: number;
      contacted: number;
      converted: number;
      conversionRate: number;
    }
  >();

  for (const r of rows) {
    // 'new' rows have no achievement — nobody owns them.
    const owner = r.talkingAch ?? r.paidAch;
    if (!owner?.adminId) continue;

    const id = String(owner.adminId);
    let row = byAdmin.get(id);
    if (!row) {
      row = {
        adminId: id,
        name: owner.adminName ?? '',
        email: owner.adminEmail ?? '',
        claimed: 0,
        contacted: 0,
        converted: 0,
        conversionRate: 0,
      };
      byAdmin.set(id, row);
    }

    if (claimedInRange(owner.claimedAt)) row.claimed++;
    if (r.intentStatus === 'contacted') row.contacted++;
    else if (r.intentStatus === 'converted') row.converted++;
  }

  const admins = [...byAdmin.values()].map((row) => ({
    ...row,
    // Hit rate: share of this admin's in-scope claims that converted.
    conversionRate:
      row.claimed > 0
        ? Math.round((row.converted / row.claimed) * 1000) / 10
        : 0,
  }));

  admins.sort((a, b) => b.converted - a.converted || b.claimed - a.claimed);
  return { admins };
}

interface AchievementRef {
  _id?: mongoose.Types.ObjectId;
  adminId: mongoose.Types.ObjectId;
  adminName: string;
  adminEmail: string;
  status: 'talking' | 'paid';
  claimedAt: Date;
  paidAt?: Date;
}

// ─── Per-admin achievements (booking-intent stats modal) ────────────

/**
 * The exact displayed rows this admin OWNS — same pipeline, scope,
 * eligibility, delay, and every page filter as the list + stats, so the
 * modal rows always match the numbers in the stats table (talking ↔
 * contacted, paid ↔ converted). Each row shows the customer's LATEST
 * order — the same `doc` the table renders — not the order that was
 * originally claimed.
 */
export async function getAdminAchievements(
  adminId: string,
  params: IntentFilterParams,
) {
  const delayMinutes = await getBookingIntentDelayMinutes();
  const cutoff = new Date(Date.now() - delayMinutes * 60_000);
  const { docFilters } = await buildIntentDocFilters(params, cutoff);

  const rows = (await ordersAgg([
    { $match: SCOPE_MATCH },
    { $sort: { createdAt: -1, _id: -1 } },
    ...intentPipelineStages(),
    { $match: { $and: docFilters } },
    // Owning achievement — same resolution the stats use.
    {
      $addFields: {
        ownerAch: { $ifNull: ['$talkingAch', '$paidAch'] },
      },
    },
    {
      $match: {
        'ownerAch.adminId': new mongoose.Types.ObjectId(adminId),
      },
    },
    // Talking rows first (active conversations), newest claims first.
    {
      $addFields: {
        sortKey: { $cond: [{ $eq: ['$intentStatus', 'contacted'] }, 0, 1] },
      },
    },
    { $sort: { sortKey: 1, 'ownerAch.claimedAt': -1 } },
    { $limit: 200 },
  ])) as Array<{
    _id: string;
    doc: IOrder;
    intentStatus: BookingIntentStatus;
    ownerAch: AchievementRef;
  }>;

  return {
    achievements: rows.map((row) => {
      const order = row.doc;
      const owner = row.ownerAch;
      return {
        _id: String(owner._id ?? row._id),
        customerKey: String(row._id),
        // Badge mirrors the derived row status: a converted row whose
        // achievement hasn't flipped to 'paid' yet still reads paid.
        status: (row.intentStatus === 'converted'
          ? 'paid'
          : 'talking') as 'talking' | 'paid',
        claimedAt: owner.claimedAt,
        paidAt: owner.paidAt,
        customer: {
          fullName: order?.billingData?.fullName ?? '',
          email: order?.billingData?.email ?? '',
          phone: order?.billingData?.phone ?? '',
          country: order?.billingData?.country ?? '',
        },
        reservationName: order ? extractReservationName(order) : undefined,
        order: order
          ? {
            _id: String(order._id),
            orderNumber: order.orderNumber ?? '',
            status: order.status,
            createdAt: order.createdAt,
            amount: order.fullAmount ?? order.totalAmount ?? 0,
            currency: order.currency ?? 'EGP',
          }
          : undefined,
      };
    }),
  };
}
