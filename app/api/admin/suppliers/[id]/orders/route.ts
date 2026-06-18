import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import SupplierOrder from '@/lib/models/SupplierOrder';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { supplierOrderCreateSchema } from '@/lib/validation/schemas';

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
    const status = searchParams.get('status') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = { supplierId: id };
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      SupplierOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierOrder.countDocuments(filter),
    ]);

    return NextResponse.json({
      success: true,
      data: { orders, total, page, limit },
    });
  } catch (error) {
    console.error('Error fetching supplier orders:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch supplier orders' },
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

    const parsed = await parseJsonBody(request, supplierOrderCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const totalAmount = body.items.reduce((sum, item) => sum + item.total, 0);

    const order = await SupplierOrder.create({
      supplierId: id,
      items: body.items,
      totalAmount,
      orderDate: body.orderDate ? new Date(body.orderDate) : new Date(),
      notes: body.notes,
      status: body.status || 'pending',
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'supplierOrder',
      resourceId: order._id.toString(),
      details: `Created order for supplier ${supplier.name}: ${totalAmount}`,
    });

    return NextResponse.json(
      { success: true, data: order.toObject() },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating supplier order:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create supplier order' },
      { status: 500 },
    );
  }
}
