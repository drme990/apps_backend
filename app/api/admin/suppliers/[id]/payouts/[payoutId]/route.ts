import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import Transaction from '@/lib/models/Transaction';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { transactionUpdateSchema } from '@/lib/validation/schemas';

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

    const parsed = await parseJsonBody(request, transactionUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const oldTransaction = await Transaction.findOne({ _id: payoutId, source: 'supplier', sourceId: id }).lean();
    const oldAmount = oldTransaction?.amount || 0;

    const updateData: Record<string, unknown> = {};
    if (body.amount !== undefined) updateData.amount = body.amount;
    if (body.accountId !== undefined) updateData.accountId = body.accountId ? new mongoose.Types.ObjectId(body.accountId) : null;
    if (body.date) updateData.date = new Date(body.date);
    if (body.paymentMethod !== undefined) updateData.paymentMethod = body.paymentMethod;
    if (body.referenceNumber !== undefined) updateData.referenceNumber = body.referenceNumber;
    if (body.linkedOrderId !== undefined) updateData.linkedOrderId = body.linkedOrderId ? new mongoose.Types.ObjectId(body.linkedOrderId) : null;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.attachment !== undefined) updateData.attachment = body.attachment;

    const transaction = await Transaction.findOneAndUpdate(
      { _id: payoutId, source: 'supplier', sourceId: id },
      updateData,
      { new: true, runValidators: true },
    ).lean();

    if (!transaction) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found' },
        { status: 404 },
      );
    }

    const delta = (transaction.amount || 0) - oldAmount;
    if (delta !== 0) {
      await Supplier.findByIdAndUpdate(id, {
        $inc: { balance: delta, totalPayouts: delta },
      });
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'supplier',
      resourceId: payoutId,
      details: `Updated payment for supplier ${supplier.name}`,
    });

    return NextResponse.json({ success: true, data: transaction });
  } catch (error) {
    console.error('Error updating supplier transaction:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update supplier transaction' },
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

    const transaction = await Transaction.findOneAndDelete({ _id: payoutId, source: 'supplier', sourceId: id }).lean();
    if (!transaction) {
      return NextResponse.json(
        { success: false, error: 'Transaction not found' },
        { status: 404 },
      );
    }

    await Supplier.findByIdAndUpdate(id, {
      $inc: { balance: -(transaction.amount || 0), totalPayouts: -(transaction.amount || 0) },
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'supplier',
      resourceId: payoutId,
      details: `Deleted payment for supplier ${supplier.name}`,
    });

    return NextResponse.json({ success: true, message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Error deleting supplier transaction:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete supplier transaction' },
      { status: 500 },
    );
  }
}
