import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import Order from '@/lib/models/Order';
import { normalizeReservationFields } from '@/lib/reservation-fields';
import { logActivity } from '@/lib/services/logger';
import { parseJsonBody } from '@/lib/validation/http';
import { productCreateSchema } from '@/lib/validation/schemas';
import { normalizeProductMedia } from '@/lib/product-media';
import { resolveProductPrices } from '@/lib/services/price-resolver';
import { normalizeCountryCode, countryNameToCode, type CountryVisibilityMode } from '@/lib/country-visibility';
import { getClientCountry } from '@/lib/utils/ip';
import { getUserModelByAppId } from '@/lib/auth/app-users';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    // Products list is needed by both the products page and the manual
    // order modal (orders page). Allow either permission.
    const auth = await requireAdminPageAccess(['products', 'orders']);
    if ('error' in auth) return auth.error;

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status')?.trim().toLowerCase();

    const query: Record<string, unknown> = { isDeleted: { $ne: true } };
    if (status === 'active') {
      query.isActive = true;
    }

    const products = await Product.find(query)
      .sort({ displayOrder: 1, createdAt: -1 })
      .limit(1000)
      .lean();

    const normalizedProducts = products.map((product) => ({
      ...(() => {
        const productWithLegacy = product as typeof product & {
          images?: unknown;
        };
        const safeProduct = {
          ...productWithLegacy,
        };
        delete safeProduct.images;
        return safeProduct;
      })(),
      media: normalizeProductMedia(product.media),
      reservationFields: normalizeReservationFields(
        product.reservationFields,
      ),
    }));

    // Price resolution: only when resolvePrices=1 is passed (from the
    // order-edit modal). The products management page gets raw prices[]
    // for editing — no resolution, no stripping.
    //
    // Priority for determining the viewer country:
    // 1. Explicit viewerCountryCode query param
    // 2. Customer's detectedCountry (looked up from the order's user)
    // 3. Admin's IP country (fallback)
    const shouldResolvePrices = searchParams.get('resolvePrices') === '1';

    let effectiveViewerCode: string | null = null;
    let viewerCurrencyCode: string | null = null;

    if (shouldResolvePrices) {
      const explicitViewerCode = normalizeCountryCode(
        searchParams.get('viewerCountryCode'),
      );

      let customerCountryCode: string | null = null;
      const orderId = searchParams.get('orderId');
      if (!explicitViewerCode && orderId) {
        try {
          const order = await Order.findById(orderId)
            .select('userId source')
            .lean();
          if (order?.userId && order.source) {
            // Cast to a minimal model interface — we only need findById
            // with .select().lean(). The union return type of
            // getUserModelByAppId has incompatible findById signatures.
            const UserModel = getUserModelByAppId(order.source) as unknown as {
              findById(id: unknown): {
                select(fields: string): {
                  lean(): Promise<{ detectedCountry?: string } | null>;
                };
              };
            };
            const user = await UserModel.findById(order.userId)
              .select('detectedCountry')
              .lean();
            if (user?.detectedCountry) {
              // detectedCountry may be a 2-letter code or a full country
              // name (legacy records) — normalize to a code.
              customerCountryCode =
                normalizeCountryCode(user.detectedCountry) ||
                countryNameToCode(user.detectedCountry);
            }
          }
        } catch {
          // Non-fatal — fall through to IP detection
        }
      }

      effectiveViewerCode =
        explicitViewerCode ||
        customerCountryCode ||
        normalizeCountryCode(getClientCountry(request));

      if (effectiveViewerCode) {
        const allCountries = await Country.find({ isActive: true }).lean();
        // Find the viewer's currency for the response so the frontend
        // can display prices in the customer's currency.
        const viewerCountry = allCountries.find(
          (c) => c.code.toUpperCase() === effectiveViewerCode!.toUpperCase(),
        );
        viewerCurrencyCode = viewerCountry?.currencyCode || null;
        await resolveProductPrices(
          normalizedProducts as Record<string, unknown>[],
          effectiveViewerCode,
          allCountries as unknown as Array<{
            code: string;
            currencyCode: string;
            roundingRule?: string | null;
            visibilityMode?: CountryVisibilityMode;
            countriesToSee?: unknown;
          }>,
        );
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        products: normalizedProducts,
        viewerCountryCode: effectiveViewerCode,
        viewerCurrencyCode,
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

export async function POST(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('products');
    if ('error' in auth) return auth.error;

    const parsed = await parseJsonBody(request, productCreateSchema);
    if (!parsed.success) return parsed.response;
    const body = parsed.data;

    // Check if slug already exists
    const existingSlug = await Product.findOne({ slug: body.slug });
    if (existingSlug) {
      return NextResponse.json(
        { success: false, error: 'Product slug already exists' },
        { status: 409 },
      );
    }

    const normalizedMedia = normalizeProductMedia(body.media);
    const product = await Product.create({
      ...body,
      media: normalizedMedia,
      reservationFields: normalizeReservationFields(body.reservationFields),
    });

    const productObject = product.toObject();
    const responseMedia = normalizeProductMedia(productObject.media);

    await logActivity({
      userId: auth.user.userId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      action: 'create',
      resource: 'product',
      resourceId: product._id.toString(),
      details: `Created product: ${product.name.en || product.name.ar}`,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...productObject,
          media: responseMedia,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create product' },
      { status: 500 },
    );
  }
}
