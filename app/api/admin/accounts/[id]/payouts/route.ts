import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Account from '@/lib/models/Account';
import Transaction from '@/lib/models/Transaction';
import Supplier from '@/lib/models/Supplier';
import mongoose from 'mongoose';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('accounts');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const account = await Account.findById(id).lean();
    if (!account) {
      return NextResponse.json(
        { success: false, error: 'Account not found' },
        { status: 404 },
      );
    }

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(200, parseInt(searchParams.get('limit') || '50', 10)));
    const skip = (page - 1) * limit;

    const accountObjectId = new mongoose.Types.ObjectId(id);

    const [transactions, total] = await Promise.all([
      Transaction.find({ accountId: accountObjectId })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({ accountId: accountObjectId }),
    ]);

    // Manual population: sourceId is polymorphic (no ref in schema)
    const supplierIds = transactions
      .filter((tx) => tx.source === 'supplier' && tx.sourceId)
      .map((tx) => String(tx.sourceId));

    const suppliers = supplierIds.length
      ? await Supplier.find({ _id: { $in: supplierIds } }).select('name').lean()
      : [];

    const supplierMap = new Map(
      suppliers.map((s) => [String(s._id), s.name as string]),
    );

    const normalizedTransactions = transactions.map((tx) => {
      let sourceEntity: { _id: string; name: string } | undefined;

      if (tx.source === 'supplier' && tx.sourceId) {
        const name = supplierMap.get(String(tx.sourceId));
        if (name) {
          sourceEntity = { _id: String(tx.sourceId), name };
        }
      }

      return {
        ...tx,
        sourceId: tx.sourceId ? String(tx.sourceId) : undefined,
        sourceEntity,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        transactions: normalizedTransactions,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('Error fetching account transactions:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch account transactions' },
      { status: 500 },
    );
  }
}
