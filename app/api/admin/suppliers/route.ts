import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Supplier from '@/lib/models/Supplier';
import SupplierOrder from '@/lib/models/SupplierOrder';
import SupplierPayout from '@/lib/models/SupplierPayout';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { supplierCreateSchema } from '@/lib/validation/schemas';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const search = searchParams.get('search')?.trim() || '';
    const status = searchParams.get('status') || '';
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (status) {
      filter.status = status;
    }

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Supplier.countDocuments(filter),
    ]);

    // Compute balance for each supplier
    const supplierIds = suppliers.map((s) => s._id.toString());
    const supplierObjectIds = supplierIds.map((id) => new mongoose.Types.ObjectId(id));
    const [ordersAgg, payoutsAgg] = await Promise.all([
      SupplierOrder.aggregate([
        { $match: { supplierId: { $in: supplierObjectIds }, status: { $ne: 'cancelled' } } },
        { $group: { _id: '$supplierId', total: { $sum: '$totalAmount' } } },
      ]),
      SupplierPayout.aggregate([
        { $match: { supplierId: { $in: supplierObjectIds } } },
        { $group: { _id: '$supplierId', total: { $sum: '$amount' } } },
      ]),
    ]);

    const orderMap = new Map(ordersAgg.map((o) => [o._id.toString(), o.total]));
    const payoutMap = new Map(payoutsAgg.map((p) => [p._id.toString(), p.total]));

    const enriched = suppliers.map((s) => {
      const id = s._id.toString();
      const totalOrders = orderMap.get(id) || 0;
      const totalPayouts = payoutMap.get(id) || 0;
      return {
        ...s,
        totalOrders,
        totalPayouts,
        balance: totalOrders - totalPayouts,
      };
    });

    return NextResponse.json({
      success: true,
      data: { suppliers: enriched, total, page, limit },
    });
  } catch (error) {
    console.error('Error fetching suppliers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch suppliers' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('suppliers');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, supplierCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    const supplier = await Supplier.create(body);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'supplier',
      resourceId: supplier._id.toString(),
      details: `Created supplier: ${supplier.name}`,
    });

    return NextResponse.json(
      { success: true, data: supplier.toObject() },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating supplier:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create supplier' },
      { status: 500 },
    );
  }
}
