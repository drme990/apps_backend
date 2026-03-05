import { NextRequest, NextResponse } from 'next/server';

function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function getCorsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigins = getAllowedOrigins();
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };

  if (
    !origin ||
    allowedOrigins.length === 0 ||
    allowedOrigins.includes(origin)
  ) {
    headers['Access-Control-Allow-Origin'] = origin || '*';
  }

  return headers;
}

export function proxy(request: NextRequest) {
  // Only handle /api routes
  if (!request.nextUrl.pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  const origin = request.headers.get('origin');

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: getCorsHeaders(origin),
    });
  }

  const response = NextResponse.next();
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
