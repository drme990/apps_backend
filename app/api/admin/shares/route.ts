import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import ShareCampaign from '@/lib/models/ShareCampaign';
import Product from '@/lib/models/Product';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { shareCampaignCreateSchema } from '@/lib/validation/schemas';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const page = parseInt(request.nextUrl.searchParams.get('page') || '1');
    const limit = parseInt(request.nextUrl.searchParams.get('limit') || '100');
    const maxLimit = Math.min(limit, 200);
    const skip = (page - 1) * maxLimit;
    const status = request.nextUrl.searchParams.get('status');
    const productId = request.nextUrl.searchParams.get('productId');

    const filter: Record<string, unknown> = {};
    if (status === 'active' || status === 'inactive' || status === 'completed') {
      filter.status = status;
    }
    if (productId) {
      filter.productId = productId;
    }

    const [campaigns, total] = await Promise.all([
      ShareCampaign.find(filter)
        .sort({ productId: 1, campaignNumber: 1 })
        .skip(skip)
        .limit(maxLimit)
        .lean(),
      ShareCampaign.countDocuments(filter),
    ]);

    // Enrich with product info
    const productIds = [...new Set(campaigns.map((c) => String(c.productId)))];
    const products = await Product.find(
      { _id: { $in: productIds } },
      { name: 1, slug: 1, sizes: 1, baseCurrency: 1, media: 1 },
    ).lean();
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    const enriched = campaigns.map((c) => {
      const product = productMap.get(String(c.productId));
      return {
        ...c,
        _id: String(c._id),
        productId: String(c.productId),
        productName: product?.name || null,
        productSlug: product?.slug || null,
        productMedia: product?.media || [],
        productSizes: product?.sizes?.map((s, i) => ({
          sizeIndex: i,
          name: s.name,
          basePrice: s.basePrice,
        })) || [],
        baseCurrency: product?.baseCurrency || null,
      };
    });

    const totalPages = Math.ceil(total / maxLimit);
    return NextResponse.json({
      success: true,
      data: { campaigns: enriched, pagination: { totalPages, total } },
    });
  } catch (error) {
    console.error('Error fetching share campaigns:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch share campaigns' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('orders');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, shareCampaignCreateSchema);
    if (!parsed.success) return parsed.response;
    const { productId, campaignNumber, totalShares, sizes } = parsed.data;

    // Validate product exists
    const product = await Product.findById(productId).lean();
    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

    // Validate all size indexes
    for (const { sizeIndex } of sizes) {
      if (!product.sizes || sizeIndex >= product.sizes.length) {
        return NextResponse.json(
          {
            success: false,
            error: `Invalid size index ${sizeIndex} for this product`,
          },
          { status: 400 },
        );
      }
    }

    // Check for existing active campaign
    const existing = await ShareCampaign.findOne({
      productId,
      status: 'active',
    }).lean();

    if (existing) {
      return NextResponse.json(
        {
          success: false,
          error: 'An active campaign already exists for this product',
        },
        { status: 400 },
      );
    }

    const campaign = await ShareCampaign.create({
      productId,
      totalShares,
      soldShares: 0,
      status: 'active',
      campaignNumber,
      sizes,
      completedAt: null,
    });

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'shareCampaign',
      resourceId: String(campaign._id),
      details: `Created share campaign #${campaignNumber} for product ${product.name.en} with ${sizes.length} sizes`,
    });

    return NextResponse.json(
      { success: true, data: campaign },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating share campaign:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create share campaign' },
      { status: 500 },
    );
  }
}
