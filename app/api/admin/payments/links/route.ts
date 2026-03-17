import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import PaymentLink from '@/lib/models/PaymentLink';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAuth();
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
      query.usedAt = { $ne: null };
    } else if (usage === 'unused') {
      query.usedAt = null;
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
    const links = rows.map((row) => {
      const isExpired = new Date(row.expiresAt).getTime() <= now;
      const usedAt = (row as { usedAt?: Date }).usedAt || null;

      return {
        _id: String(row._id),
        id: String(row._id),
        kind: row.kind,
        source: row.source,
        orderNumber: row.orderNumber || null,
        amountRequested: row.amountRequested,
        currency: row.currencyCode,
        isCustomAmount: !!row.isCustomAmount,
        isUsed: !!usedAt,
        isExpired,
        usedAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
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
