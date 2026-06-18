import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import SupplierPayout from '@/lib/models/SupplierPayout';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { supplierPayoutCreateSchema } from '@/lib/validation/schemas';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    const { searchParams } = request.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const [rawPayouts, total] = await Promise.all([
      SupplierPayout.find({ supplierId: id })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .populate('accountId', 'name currency type')
        .lean(),
      SupplierPayout.countDocuments({ supplierId: id }),
    ]);

    const payouts = rawPayouts.map((p) => {
      const account =
        p.accountId && typeof p.accountId === 'object'
          ? {
            _id: String((p.accountId as unknown as { _id: mongoose.Types.ObjectId })._id),
            name: (p.accountId as unknown as { name: string }).name,
            currency: (p.accountId as unknown as { currency: string }).currency,
            type: (p.accountId as unknown as { type: string }).type,
          }
          : undefined;
      return {
        ...p,
        accountId: account ? account._id : p.accountId ? String(p.accountId) : undefined,
        account,
      };
    });

    return NextResponse.json({
      success: true,
      data: { payouts, total, page, limit },
    });
  } catch (error) {
    console.error('Error fetching supplier payouts:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch supplier payouts' },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    const parsed = await parseJsonBody(request, supplierPayoutCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const payout = (await SupplierPayout.create({
      supplierId: id,
      amount: body.amount,
      accountId: body.accountId ? new mongoose.Types.ObjectId(body.accountId) : null,
      date: body.date ? new Date(body.date) : new Date(),
      notes: body.notes,
    } as unknown as Record<string, unknown>)) as mongoose.Document & { _id: mongoose.Types.ObjectId; toObject: () => Record<string, unknown> };

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'supplierPayout',
      resourceId: payout._id.toString(),
      details: `Created payout for supplier ${supplier.name}: ${body.amount}`,
    });

    return NextResponse.json(
      { success: true, data: payout.toObject() },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating supplier payout:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create supplier payout' },
      { status: 500 },
    );
  }
}
