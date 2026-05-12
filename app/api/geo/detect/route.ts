import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const VERCEL_COUNTRY_HEADER = 'x-vercel-ip-country';
const VERCEL_IP_HEADER = 'x-vercel-ip-address';

export type GeoDetectErrorCode = 'COUNTRY_NOT_DETECTED';

function normalizeCountryCode(raw: string | null): string | null {
  if (!raw) return null;
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

async function getCountryFromIpApi(ip: string): Promise<string | null> {
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode`,
      {
        cache: 'no-store',
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { countryCode?: string | null };
    return normalizeCountryCode(data.countryCode ?? null);
  } catch {
    return null;
  }
}

/**
 * POST /api/geo/detect
 * Detects country from request IP or optional lat/lng from browser geolocation
 *
 * Request body (optional):
 *   { lat?: number; lng?: number }
 *
 * Response:
 *   Success: { success: true, data: { countryCode: string } }
 *   Error: { success: false, error: 'COUNTRY_NOT_DETECTED', code: 'COUNTRY_NOT_DETECTED' }
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Try Vercel header first (most reliable when hosted on Vercel)
    const countryFromVercel = normalizeCountryCode(
      request.headers.get(VERCEL_COUNTRY_HEADER),
    );
    if (countryFromVercel) {
      return NextResponse.json(
        {
          success: true,
          data: { countryCode: countryFromVercel },
        },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          },
        },
      );
    }

    // 2. Try IP-based detection
    const ip = getClientIp(request);
    if (ip) {
      const countryFromIp = await getCountryFromCountryIs(ip);
      if (countryFromIp) {
        return NextResponse.json(
          {
            success: true,
            data: { countryCode: countryFromIp },
          },
          {
            headers: {
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
          },
        );
      }

      // 3. Try backup IP service
      const countryFromIpApi = await getCountryFromIpApi(ip);
      if (countryFromIpApi) {
        return NextResponse.json(
          {
            success: true,
            data: { countryCode: countryFromIpApi },
          },
          {
            headers: {
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
          },
        );
      }
    }

    // 4. Check if lat/lng provided from browser geolocation
    let body: { lat?: number; lng?: number } | null = null;
    try {
      body = await request.json();
    } catch {
      // No body or invalid JSON, continue
    }

    if (typeof body?.lat === 'number' && typeof body?.lng === 'number') {
      // Reverse geocode lat/lng to country
      try {
        const res = await fetch(
          `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(body.lat)}&longitude=${encodeURIComponent(body.lng)}&localityLanguage=en`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          const data = (await res.json()) as { countryCode?: string };
          const countryCode = normalizeCountryCode(data.countryCode ?? null);
          if (countryCode) {
            return NextResponse.json(
              {
                success: true,
                data: { countryCode },
              },
              {
                headers: {
                  'Cache-Control': 'no-store, no-cache, must-revalidate',
                },
              },
            );
          }
        }
      } catch {
        // Continue to error response
      }
    }

    // 5. Could not detect country - return error code for frontend to handle
    return NextResponse.json(
      {
        success: false,
        error: 'COUNTRY_NOT_DETECTED',
        code: 'COUNTRY_NOT_DETECTED' as GeoDetectErrorCode,
        message: 'Unable to detect country from IP or geolocation',
      },
      {
        status: 200, // Return 200 so frontend can handle it gracefully
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      },
    );
  } catch (error) {
    console.error('[geo/detect] Error:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'COUNTRY_NOT_DETECTED',
        code: 'COUNTRY_NOT_DETECTED' as GeoDetectErrorCode,
        message: 'Internal error during country detection',
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      },
    );
  }
}

/**
 * GET /api/geo/detect
 * Simple IP-based detection without browser geolocation fallback
 */
export async function GET(request: NextRequest) {
  return POST(request);
}
