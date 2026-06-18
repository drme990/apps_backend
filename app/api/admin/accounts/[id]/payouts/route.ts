import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Account from '@/lib/models/Account';
import SupplierPayout from '@/lib/models/SupplierPayout';
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

    const [payouts, total] = await Promise.all([
      SupplierPayout.find({ accountId: accountObjectId })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .populate('supplierId', 'name')
        .lean(),
      SupplierPayout.countDocuments({ accountId: accountObjectId }),
    ]);

    const normalizedPayouts = payouts.map((p) => {
      const supplier =
        p.supplierId && typeof p.supplierId === 'object'
          ? {
              _id: String((p.supplierId as unknown as { _id: mongoose.Types.ObjectId })._id),
              name: (p.supplierId as unknown as { name: string }).name,
            }
          : undefined;

      return {
        ...p,
        supplierId: supplier ? supplier._id : p.supplierId ? String(p.supplierId) : undefined,
        supplier,
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        payouts: normalizedPayouts,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('Error fetching account payouts:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch account payouts' },
      { status: 500 },
    );
  }
}
