import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Product from '@/lib/models/Product';
import Country from '@/lib/models/Country';
import ShareCampaign from '@/lib/models/ShareCampaign';
import {
  filterProductMediaForPlatform,
  normalizeProductMedia,
  parseProductPlatform,
} from '@/lib/product-media';
import { resolveProductPrices } from '@/lib/services/price-resolver';
import { stripProductForPublic } from '@/lib/product-public-mapper';
import { normalizeCountryCode, type CountryVisibilityMode } from '@/lib/country-visibility';
import { getClientCountry } from '@/lib/utils/ip';

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const platform = parseProductPlatform(
      request.nextUrl.searchParams.get('platform'),
    );
    const viewerCountryCode = normalizeCountryCode(
      request.nextUrl.searchParams.get('viewerCountryCode'),
    );
    const { id } = await params;
    const normalizedSlug = id.trim().toLowerCase();
    const isObjectId = OBJECT_ID_REGEX.test(id.trim());
    const product = await Product.findOne({
      isActive: true,
      isDeleted: { $ne: true },
      $or: isObjectId
        ? [{ _id: id.trim() }, { slug: normalizedSlug }]
        : [{ slug: normalizedSlug }],
    }).lean();

    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Product not found' },
        { status: 404 },
      );
    }

    const normalizedMedia = normalizeProductMedia(product.media);
    const filteredMedia = filterProductMediaForPlatform(
      normalizedMedia,
      platform,
    );
    const { images: _legacyImages, ...safeProduct } = product as typeof product & {
      images?: unknown;
    };
    void _legacyImages;

    const productData: Record<string, unknown> = {
      ...safeProduct,
      media: filteredMedia,
    };

    // Resolve prices for public apps (platform is set).
    // Admin panel (no platform) gets raw prices[] for editing.
    if (platform) {
      // Use the viewerCountryCode from the query string, or fall back to
      // IP-based country detection from request headers (CF/Vercel).
      // If neither is available, use 'OT' (Other) — the user will see
      // all currencies with real prices, but no exchange conversion
      // (since there's no home country to convert from).
      const effectiveViewerCode = viewerCountryCode || normalizeCountryCode(getClientCountry(request)) || 'OT';
      const allCountries = await Country.find({ isActive: true }).lean();
      await resolveProductPrices(
        [productData],
        effectiveViewerCode,
        allCountries as unknown as Array<{
          code: string;
          currencyCode: string;
          roundingRule?: string | null;
          visibilityMode?: CountryVisibilityMode;
          countriesToSee?: unknown;
        }>,
      );
      // Strip admin-only fields not needed by the frontend
      stripProductForPublic(productData);

      // Attach share-campaign progress when campaigns are flagged for
      // display on the product page. The shown campaign is per size —
      // it mirrors incrementShareCampaignSold so the displayed campaign
      // is the one a purchase of that size would actually join:
      //   - shares fit an active campaign → that campaign's progress
      //   - shares overflow it (or the size completes a whole campaign
      //     on its own, e.g. 10/10) → a new campaign is always created,
      //     so show the next campaign number.
      const flaggedCampaigns = await ShareCampaign.find({
        productId: product._id,
        status: 'active',
        displayOnProductPage: true,
      })
        .sort({ campaignNumber: 1 })
        .lean();

      if (flaggedCampaigns.length > 0) {
        const highest = await ShareCampaign.findOne(
          { productId: product._id },
          { campaignNumber: 1 },
        )
          .sort({ campaignNumber: -1 })
          .lean();
        const nextCampaignNumber = (highest?.campaignNumber ?? 0) + 1;

        const sizeIndexes = [
          ...new Set(
            flaggedCampaigns.flatMap((c) =>
              c.sizes.map((s) => s.sizeIndex),
            ),
          ),
        ];

        const bySize: Record<
          number,
          {
            campaignNumber: number;
            progressPercent: number;
            minDisplayPercent: number;
            fillsCampaign: boolean;
          }
        > = {};

        for (const sizeIndex of sizeIndexes) {
          const shares =
            flaggedCampaigns[0].sizes.find((s) => s.sizeIndex === sizeIndex)
              ?.sharesPerPurchase ?? 0;
          if (shares <= 0) continue;

          // A purchase of this size completes a whole campaign on its
          // own (e.g. 10/10) — a new campaign is always created.
          const fillsCampaign =
            shares >= flaggedCampaigns[0].totalShares;

          // Campaign that can fit this size's shares — closest to
          // completion first (same as findActiveShareCampaign).
          const fit = flaggedCampaigns
            .filter((c) => c.soldShares + shares <= c.totalShares)
            .sort((a, b) => b.soldShares - a.soldShares)[0];

          if (fit && !fillsCampaign) {
            bySize[sizeIndex] = {
              campaignNumber: fit.campaignNumber,
              progressPercent:
                fit.totalShares > 0
                  ? Math.min(
                    100,
                    Math.round((fit.soldShares / fit.totalShares) * 100),
                  )
                  : 0,
              minDisplayPercent: fit.minDisplayPercent ?? 0,
              fillsCampaign: false,
            };
          } else {
            // Full order or overflow — a new campaign is always
            // created, so show the next campaign code at 0%.
            bySize[sizeIndex] = {
              campaignNumber: nextCampaignNumber,
              progressPercent: 0,
              minDisplayPercent: flaggedCampaigns[0].minDisplayPercent ?? 0,
              fillsCampaign,
            };
          }
        }

        if (Object.keys(bySize).length > 0) {
          productData.shareCampaign = { sizes: bySize };
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: productData,
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch product' },
      { status: 500 },
    );
  }
}
