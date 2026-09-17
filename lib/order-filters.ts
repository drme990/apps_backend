import mongoose from 'mongoose';
import Category from '@/lib/models/Categories';

function parseIsoDateParts(
    value: string | null,
): { year: number; month: number; day: number } | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (Number.isNaN(date.getTime())) return null;
    return { year, month, day };
}

function parseTimezoneOffsetMinutes(value: string | null): number {
    const parsed = Number.parseInt(value || '', 10);
    if (Number.isNaN(parsed)) return 0;

    // Real-world timezone offsets typically fall between UTC-12 and UTC+14.
    if (parsed < -840 || parsed > 840) return 0;
    return parsed;
}

function getUtcStartOfLocalDay(
    dateParts: { year: number; month: number; day: number },
    timezoneOffsetMinutes: number,
): Date {
    const utcMidnightMs = Date.UTC(
        dateParts.year,
        dateParts.month - 1,
        dateParts.day,
        0,
        0,
        0,
        0,
    );
    return new Date(utcMidnightMs + timezoneOffsetMinutes * 60 * 1000);
}

export interface OrderQueryOptions {
    /**
     * Extra conditions OR-ed into the search $or group. Used by the
     * invoices endpoint so a search matching a sub-order's number still
     * surfaces the parent order's invoice rows.
     */
    extraSearchOr?: Record<string, unknown>[];
}

/**
 * Build the MongoDB query for admin order listings from URL search params.
 * Shared by /api/admin/orders and /api/admin/invoices so both apply the
 * exact same filters (status, referral, search, source, category,
 * intention, country, date range).
 */
export async function buildAdminOrdersQuery(
    searchParams: URLSearchParams,
    options?: OrderQueryOptions,
): Promise<Record<string, unknown>> {
    const status = searchParams.get('status');
    const referralId = searchParams.get('referralId');
    const search = searchParams.get('search');
    const source = searchParams.get('source');
    const whatsappState = searchParams.get('whatsappState');
    const categoryId = searchParams.get('category');
    const intention = searchParams.get('intention');
    const country = searchParams.get('country');
    const specificDate = searchParams.get('date');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');
    // Which date field to filter on: 'statusUpdateTime' (default, used by
    // orders/execution pages) or 'createdAt' (used by invoices page so
    // date ranges match order creation, not last status update).
    const dateFieldParam = searchParams.get('dateField');
    const dateField = dateFieldParam === 'createdAt' ? 'createdAt' : 'statusUpdateTime';
    const timezoneOffsetMinutes = parseTimezoneOffsetMinutes(
        searchParams.get('tzOffsetMinutes'),
    );

    // Category filter: resolve category products to match order items
    let categoryProductIds: mongoose.Types.ObjectId[] | undefined;
    if (categoryId && categoryId !== 'all') {
        const category = await Category.findById(categoryId).select('products').lean();
        if (category && Array.isArray(category.products)) {
            categoryProductIds = category.products.map((p) => {
                const str = typeof p === 'string' ? p : (p as { toString(): string }).toString();
                return new mongoose.Types.ObjectId(str);
            });
        }
    }

    const query: Record<string, unknown> = {};
    const andConditions: Record<string, unknown>[] = [];
    if (status && status !== 'all') query.status = status;
    if (referralId && referralId !== 'all') {
        if (
            referralId === 'default' ||
            referralId === 'MNK-D' ||
            referralId === 'GHD-D'
        ) {
            const sourceCondition =
                referralId === 'MNK-D'
                    ? {
                        $or: [
                            { source: 'manasik' },
                            { source: { $exists: false } },
                            { source: null },
                            { source: '' },
                        ],
                    }
                    : referralId === 'GHD-D'
                        ? { source: 'ghadaq' }
                        : null;

            andConditions.push({
                $or: [
                    { referralId: { $exists: false } },
                    { referralId: null },
                    { referralId: '' },
                    { referralId: referralId },
                ],
            });

            if (sourceCondition) {
                andConditions.push(sourceCondition);
            }
        } else {
            query.referralId = referralId;
        }
    }
    if (source && source !== 'all') query.source = source;
    if (whatsappState && whatsappState !== 'all') {
        query.isWhatsappButtonClicked = whatsappState;
    }

    if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = { $regex: escaped, $options: 'i' };
        andConditions.push({
            $or: [
                { orderNumber: regex },
                { 'billingData.fullName': regex },
                { 'billingData.email': regex },
                { 'billingData.phone': regex },
                { 'items.productName.ar': regex },
                { 'items.productName.en': regex },
                ...(options?.extraSearchOr || []),
            ],
        });
    }

    if (categoryProductIds && categoryProductIds.length > 0) {
        andConditions.push({
            'items.productId': { $in: categoryProductIds },
        });
    }

    if (intention && intention !== 'all') {
        andConditions.push({
            reservationData: {
                $elemMatch: {
                    key: 'intention',
                    value: intention,
                },
            },
        });
    }

    if (country && country !== 'all') {
        andConditions.push({
            'billingData.country': {
                $regex: `^${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                $options: 'i',
            },
        });
    }

    const updatedAtFilter: Record<string, Date> = {};
    const parsedSpecificDate = parseIsoDateParts(specificDate);

    if (parsedSpecificDate) {
        const start = getUtcStartOfLocalDay(
            parsedSpecificDate,
            timezoneOffsetMinutes,
        );

        const endExclusive = new Date(start);
        endExclusive.setDate(endExclusive.getDate() + 1);

        updatedAtFilter.$gte = start;
        updatedAtFilter.$lt = endExclusive;
    } else {
        const parsedFromDate = parseIsoDateParts(fromDate);
        const parsedToDate = parseIsoDateParts(toDate);

        if (parsedFromDate) {
            updatedAtFilter.$gte = getUtcStartOfLocalDay(
                parsedFromDate,
                timezoneOffsetMinutes,
            );
        }

        if (parsedToDate) {
            const toDateStart = getUtcStartOfLocalDay(
                parsedToDate,
                timezoneOffsetMinutes,
            );
            const toDateEndExclusive = new Date(toDateStart);
            toDateEndExclusive.setDate(toDateEndExclusive.getDate() + 1);
            updatedAtFilter.$lt = toDateEndExclusive;
        }
    }

    if (Object.keys(updatedAtFilter).length > 0) {
        query[dateField] = updatedAtFilter;
    }

    if (andConditions.length > 0) {
        query.$and = andConditions;
    }

    return query;
}
