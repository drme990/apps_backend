import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import Country from '@/lib/models/Country';

const VERCEL_COUNTRY_HEADER = 'x-vercel-ip-country';
const VERCEL_IP_HEADER = 'x-vercel-ip-address';

function normalizeCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (code === 'XX' || code === 'ZZ') return null;
  return code;
}

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

function getVisibleCountries(allCountries: any[], viewerCode: string): any[] {
  const viewer = allCountries.find((c) => c.code === viewerCode);
  if (!viewer || (viewer.visibilityMode ?? 'all') === 'all')
    return allCountries;

  const allowed = (viewer.visibleToCountries ?? []).map((c: string) =>
    String(c).toUpperCase(),
  );
  const filtered = allCountries.filter((c) =>
    allowed.includes(String(c.code).toUpperCase()),
  );

  return filtered.some((c) => c.code === viewerCode)
    ? filtered
    : [viewer, ...filtered];
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

    // Detect viewer country server-side (prefer hosting provider header)
    const countryFromVercel = normalizeCountryCode(
      request.headers.get(VERCEL_COUNTRY_HEADER),
    );

    const ip = getClientIp(request);
    const countryFromIp = ip ? await getCountryFromCountryIs(ip) : null;

    const viewerCode = countryFromVercel ?? countryFromIp ?? null;

    // If we detected a viewerCode, apply visibility rules server-side.
    const visible = viewerCode
      ? getVisibleCountries(countries, viewerCode)
      : countries;

    return NextResponse.json({
      success: true,
      data: visible,
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
