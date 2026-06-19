import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import Transaction from '@/lib/models/Transaction';
import '@/lib/models/Account';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { transactionCreateSchema } from '@/lib/validation/schemas';

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

    const [rawTransactions, total] = await Promise.all([
      Transaction.find({ source: 'supplier', sourceId: id })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .populate('accountId', 'name currency type')
        .lean(),
      Transaction.countDocuments({ source: 'supplier', sourceId: id }),
    ]);

    const transactions = rawTransactions.map((t) => {
      const account =
        t.accountId && typeof t.accountId === 'object'
          ? {
            _id: String((t.accountId as unknown as { _id: mongoose.Types.ObjectId })._id),
            name: (t.accountId as unknown as { name: string }).name,
            currency: (t.accountId as unknown as { currency: string }).currency,
            type: (t.accountId as unknown as { type: string }).type,
          }
          : undefined;
      return {
        ...t,
        accountId: account ? account._id : t.accountId ? String(t.accountId) : undefined,
        account,
      };
    });

    return NextResponse.json({
      success: true,
      data: { transactions, total, page, limit },
    });
  } catch (error) {
    console.error('Error fetching supplier transactions:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch supplier transactions' },
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

    const parsed = await parseJsonBody(request, transactionCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const transaction = await Transaction.create({
      source: 'supplier',
      sourceId: id,
      accountId: body.accountId ? new mongoose.Types.ObjectId(body.accountId) : null,
      type: 'debit',
      amount: body.amount,
      date: body.date ? new Date(body.date) : new Date(),
      paymentMethod: body.paymentMethod,
      referenceNumber: body.referenceNumber,
      linkedOrderId: body.linkedOrderId ? new mongoose.Types.ObjectId(body.linkedOrderId) : null,
      notes: body.notes,
      attachment: body.attachment,
    } as unknown as Record<string, unknown>);

    await Supplier.findByIdAndUpdate(id, {
      $inc: { balance: body.amount, totalPayouts: body.amount },
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'supplier',
      resourceId: transaction._id.toString(),
      details: `Created payment for supplier ${supplier.name}: ${body.amount}`,
    });

    return NextResponse.json(
      { success: true, data: transaction.toObject() },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating supplier transaction:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create supplier transaction' },
      { status: 500 },
    );
  }
}
