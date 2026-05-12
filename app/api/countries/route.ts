import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Country from '@/lib/models/Country';
import {
  getVisibleCountriesForViewer,
  normalizeCountryCode,
  normalizeCountryVisibilityMap,
} from '@/lib/country-visibility';

const VERCEL_IP_HEADER = 'x-vercel-ip-address';

function getClientIp(request: NextRequest): string | null {
  const direct = request.headers.get(VERCEL_IP_HEADER);
  if (direct && direct.trim()) return direct.trim();

  const forwarded = request.headers.get('x-forwarded-for');
  if (!forwarded) return null;

  const first = forwarded.split(',')[0]?.trim();
  return first || null;
}

async function getCountryFromCountryIs(ip: string): Promise<string | null> {
  try {
    const res = await fetch(`https://country.is/${encodeURIComponent(ip)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { country?: string | null };
    return normalizeCountryCode(data.country ?? null);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const active = request.nextUrl.searchParams.get('active');
    const activeOnly = active !== 'false';
    const query = activeOnly ? { isActive: true } : {};

    const countries = await Country.find(query)
      .sort({ sortOrder: 1, 'name.ar': 1 })
      .lean();
    const normalizedCountries = countries.map((country) => ({
      ...country,
      countriesToSee: normalizeCountryVisibilityMap(
        country.countriesToSee,
      ),
    }));

    const viewerCountryCode = normalizeCountryCode(
      request.nextUrl.searchParams.get('viewerCountryCode'),
    );

    // Detect viewer country server-side (prefer explicit viewerCountryCode, then hosting provider header)
    const countryFromVercel =
      viewerCountryCode ||
      normalizeCountryCode(request.headers.get('x-vercel-ip-country'));

    const ip = getClientIp(request);
    const countryFromIp = ip ? await getCountryFromCountryIs(ip) : null;

    const viewerCode = countryFromVercel ?? countryFromIp ?? null;

    // If we detected a viewerCode, apply visibility rules server-side.
    const visible = viewerCode
      ? getVisibleCountriesForViewer(normalizedCountries, viewerCode)
      : normalizedCountries.map((country) => ({
          ...country,
          viewerVisibility: { realPrice: true, exchangePrice: true },
        }));

    // Return only the required fields
    const filteredData = visible.map((country) => ({
      _id: country._id,
      code: country.code,
      name: country.name,
      currencyCode: country.currencyCode,
      currencySymbol: country.currencySymbol,
      flagEmoji: country.flagEmoji,
      sortOrder: country.sortOrder,
      viewerVisibility: country.viewerVisibility,
    }));

    return NextResponse.json({
      success: true,
      data: filteredData,
      meta: { viewerCode: viewerCode ?? null },
    });
  } catch (error) {
    console.error('Error fetching countries:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch countries' },
      { status: 500 },
    );
  }
}
