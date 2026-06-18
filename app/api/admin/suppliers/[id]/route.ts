import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import SupplierOrder from '@/lib/models/SupplierOrder';
import SupplierPayout from '@/lib/models/SupplierPayout';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { supplierUpdateSchema } from '@/lib/validation/schemas';

export async function GET(
  _request: NextRequest,
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

    const supplierObjectId = new mongoose.Types.ObjectId(id);
    const [ordersAgg, payoutsAgg] = await Promise.all([
      SupplierOrder.aggregate([
        { $match: { supplierId: supplierObjectId, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      SupplierPayout.aggregate([
        { $match: { supplierId: supplierObjectId } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);

    const totalOrders = ordersAgg[0]?.total || 0;
    const totalPayouts = payoutsAgg[0]?.total || 0;

    return NextResponse.json({
      success: true,
      data: {
        ...supplier,
        totalOrders,
        totalPayouts,
        balance: totalOrders - totalPayouts,
      },
    });
  } catch (error) {
    console.error('Error fetching supplier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch supplier' },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const parsed = await parseJsonBody(request, supplierUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const supplier = await Supplier.findByIdAndUpdate(id, body, {
      new: true,
      runValidators: true,
    }).lean();

    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'supplier',
      resourceId: id,
      details: `Updated supplier: ${supplier.name}`,
    });

    return NextResponse.json({ success: true, data: supplier });
  } catch (error) {
    console.error('Error updating supplier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update supplier' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id } = await params;
    const supplier = await Supplier.findByIdAndDelete(id).lean();

    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    // Cascade delete orders and payouts
    await Promise.all([
      SupplierOrder.deleteMany({ supplierId: id }),
      SupplierPayout.deleteMany({ supplierId: id }),
    ]);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'supplier',
      resourceId: id,
      details: `Deleted supplier: ${supplier.name}`,
    });

    return NextResponse.json({ success: true, message: 'Supplier deleted successfully' });
  } catch (error) {
    console.error('Error deleting supplier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete supplier' },
      { status: 500 },
    );
  }
}
