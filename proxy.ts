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

  // Reuse incoming trace ID from load balancer/CDN or generate a fresh one.
  const traceId =
    request.headers.get('x-request-id') ?? crypto.randomUUID();

  // Structured request log — newline-delimited JSON consumed by Vercel log drain
  // or any standard log aggregator.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      event: 'request.in',
      traceId,
      method: request.method,
      path: request.nextUrl.pathname,
    }),
  );

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: { ...getCorsHeaders(origin), 'x-request-id': traceId },
    });
  }

  const response = NextResponse.next();
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  // Propagate trace ID so callers can correlate frontend and backend logs.
  response.headers.set('x-request-id', traceId);

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
