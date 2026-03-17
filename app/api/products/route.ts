import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import { normalizeReservationFields } from '@/lib/reservation-fields';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = request.nextUrl;
    const limit = parseInt(searchParams.get('limit') || '10');
    const page = parseInt(searchParams.get('page') || '1');
    const inStock = searchParams.get('inStock');
    const sacrifice = searchParams.get('sacrifice');

    const query: Record<string, unknown> = {
      isActive: true,
      isDeleted: { $ne: true },
    };
    if (inStock !== null) query.inStock = inStock === 'true';
    if (sacrifice === 'true') query.workAsSacrifice = true;

    const skip = (page - 1) * limit;

    const products = await Product.find(query)
      .sort({ displayOrder: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      success: true,
      data: {
        products: products.map((product) => ({
          ...product,
          reservationFields: normalizeReservationFields(
            product.reservationFields,
          ),
        })),
        pagination: {
          currentPage: page,
          totalPages,
          totalProducts: total,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch products' },
      { status: 500 },
    );
  }
}
