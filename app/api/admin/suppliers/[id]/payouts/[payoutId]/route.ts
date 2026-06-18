import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import SupplierPayout from '@/lib/models/SupplierPayout';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { supplierPayoutUpdateSchema } from '@/lib/validation/schemas';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; payoutId: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id, payoutId } = await params;
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    const parsed = await parseJsonBody(request, supplierPayoutUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const updateData: Record<string, unknown> = {};
    if (body.amount !== undefined) updateData.amount = body.amount;
    if (body.accountId !== undefined) updateData.accountId = body.accountId || null;
    if (body.date) updateData.date = new Date(body.date);
    if (body.notes !== undefined) updateData.notes = body.notes;

    const payout = await SupplierPayout.findOneAndUpdate(
      { _id: payoutId, supplierId: id },
      updateData,
      { new: true, runValidators: true },
    ).lean();

    if (!payout) {
      return NextResponse.json(
        { success: false, error: 'Payout not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'supplierPayout',
      resourceId: payoutId,
      details: `Updated payout for supplier ${supplier.name}`,
    });

    return NextResponse.json({ success: true, data: payout });
  } catch (error) {
    console.error('Error updating supplier payout:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update supplier payout' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; payoutId: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id, payoutId } = await params;
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    const payout = await SupplierPayout.findOneAndDelete({ _id: payoutId, supplierId: id }).lean();
    if (!payout) {
      return NextResponse.json(
        { success: false, error: 'Payout not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'supplierPayout',
      resourceId: payoutId,
      details: `Deleted payout for supplier ${supplier.name}`,
    });

    return NextResponse.json({ success: true, message: 'Payout deleted successfully' });
  } catch (error) {
    console.error('Error deleting supplier payout:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete supplier payout' },
      { status: 500 },
    );
  }
}
