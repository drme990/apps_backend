import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import SupplierOrder from '@/lib/models/SupplierOrder';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { supplierOrderUpdateSchema } from '@/lib/validation/schemas';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id, orderId } = await params;
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    const parsed = await parseJsonBody(request, supplierOrderUpdateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const oldOrder = await SupplierOrder.findOne({ _id: orderId, supplierId: id }).lean();
    const oldTotal = oldOrder?.totalAmount || 0;

    const updateData: Record<string, unknown> = {};
    if (body.items) {
      updateData.items = body.items;
      updateData.totalAmount = body.items.reduce((sum, item) => sum + item.total, 0);
    }
    if (body.orderDate) updateData.orderDate = new Date(body.orderDate);
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (body.status) updateData.status = body.status;

    const order = await SupplierOrder.findOneAndUpdate(
      { _id: orderId, supplierId: id },
      updateData,
      { new: true, runValidators: true },
    ).lean();

    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    const delta = (order.totalAmount || 0) - oldTotal;
    if (delta !== 0) {
      await Supplier.findByIdAndUpdate(id, {
        $inc: { balance: -delta, totalOrders: delta },
      });
    }

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'update',
      resource: 'supplier',
      resourceId: orderId,
      details: `Updated order for supplier ${supplier.name}`,
    });

    return NextResponse.json({ success: true, data: order });
  } catch (error) {
    console.error('Error updating supplier order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update supplier order' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; orderId: string }> },
) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { id, orderId } = await params;
    const supplier = await Supplier.findById(id).lean();
    if (!supplier) {
      return NextResponse.json(
        { success: false, error: 'Supplier not found' },
        { status: 404 },
      );
    }

    const order = await SupplierOrder.findOneAndDelete({ _id: orderId, supplierId: id }).lean();
    if (!order) {
      return NextResponse.json(
        { success: false, error: 'Order not found' },
        { status: 404 },
      );
    }

    await Supplier.findByIdAndUpdate(id, {
      $inc: { balance: (order.totalAmount || 0), totalOrders: -(order.totalAmount || 0) },
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'delete',
      resource: 'supplier',
      resourceId: orderId,
      details: `Deleted order for supplier ${supplier.name}`,
    });

    return NextResponse.json({ success: true, message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Error deleting supplier order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete supplier order' },
      { status: 500 },
    );
  }
}
