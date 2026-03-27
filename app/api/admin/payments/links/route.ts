import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import PaymentLink from '@/lib/models/PaymentLink';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('payments');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(
      100,
      Math.max(10, parseInt(searchParams.get('limit') || '20', 10)),
    );
    const source = (searchParams.get('source') || '').trim();
    const kind = (searchParams.get('kind') || '').trim();
    const usage = (searchParams.get('usage') || '').trim();
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {
      isDeleted: { $ne: true },
    };
    if (source && source !== 'all') query.source = source;
    if (kind && kind !== 'all') query.kind = kind;
    if (usage === 'used') {
      query.status = 'used';
    } else if (usage === 'unused') {
      query.status = 'unused';
    } else if (usage === 'opened') {
      query.status = 'opened';
    }

    const [rows, total] = await Promise.all([
      PaymentLink.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PaymentLink.countDocuments(query),
    ]);

    const now = Date.now();
    const sourceBaseUrls: Record<'manasik' | 'ghadaq', string> = {
      manasik: process.env.MANASIK_URL || 'https://www.manasik.net',
      ghadaq: process.env.GHADAQ_URL || 'https://www.ghadaqplus.com',
    };

    const links = rows.map((row) => {
      const isExpired = new Date(row.expiresAt).getTime() <= now;
      const usedAt = (row as { usedAt?: Date }).usedAt || null;
      const openedAt = (row as { openedAt?: Date }).openedAt || null;
      const status = row.status || (usedAt ? 'used' : 'unused');
      const linkPath =
        row.kind === 'order'
          ? `/payment/pay-link/${row.publicToken}`
          : `/payment/custom-pay-link/${row.publicToken}`;
      const payLinkUrl = row.publicToken
        ? `${sourceBaseUrls[row.source]}${linkPath}`
        : null;

      return {
        _id: String(row._id),
        id: String(row._id),
        kind: row.kind,
        source: row.source,
        orderNumber: row.orderNumber || null,
        amountRequested: row.amountRequested,
        currency: row.currencyCode,
        isCustomAmount: !!row.isCustomAmount,
        status,
        isUsed: !!usedAt,
        isExpired,
        openedAt,
        usedAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        payLinkUrl,
        createdBy: row.createdBy,
      };
    });

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return NextResponse.json({
      success: true,
      data: {
        links,
        pagination: {
          currentPage: page,
          totalPages,
          totalItems: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching payment links:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch payment links' },
      { status: 500 },
    );
  }
}
