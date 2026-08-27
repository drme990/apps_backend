import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/db';
import ErrorLog, { type IErrorLog } from '@/lib/models/ErrorLog';
import { verifyToken } from '@/lib/services/jwt';

export interface LogErrorOptions {
  level?: 'error' | 'warn' | 'fatal';
  message: string;
  stack?: string;
  source?: string;
  statusCode?: number;
  appId?: string;
  metadata?: Record<string, unknown>;
  /** Override user data (otherwise extracted from request) */
  user?: {
    userId?: string;
    email?: string;
    name?: string;
    role?: string;
  };
  /** Override session data (otherwise extracted from request) */
  session?: {
    ip?: string;
    userAgent?: string;
    locale?: string;
    traceId?: string;
    referrer?: string;
  };
}

/**
 * Log an error to the database with request context.
 *
 * This function is designed to NEVER throw — if the DB write fails,
 * it silently logs to console instead of causing a cascade of errors.
 *
 * @param request  The Next.js request object (for extracting IP, headers, etc.)
 * @param options  Error details and optional context overrides
 */
export async function logError(
  request: NextRequest | null,
  options: LogErrorOptions,
): Promise<void> {
  const {
    level = 'error',
    message,
    stack,
    source,
    statusCode,
    appId,
    metadata,
    user: userOverride,
    session: sessionOverride,
  } = options;

  // Extract request context
  let user = userOverride;
  let session = sessionOverride;

  if (request && (!user || !session)) {
    // Extract IP
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      undefined;

    // Extract user agent
    const userAgent = request.headers.get('user-agent') || undefined;

    // Extract locale from URL or headers
    const locale =
      request.nextUrl.pathname.match(/\/(ar|en)\//)?.[1] ||
      request.headers.get('accept-language')?.split(',')[0]?.split('-')[0] ||
      undefined;

    // Extract referrer
    const referrer = request.headers.get('referer') || undefined;

    // Extract trace ID if present
    const traceId =
      request.headers.get('x-trace-id') ||
      request.nextUrl.searchParams.get('traceId') ||
      undefined;

    if (!session) {
      session = { ip, userAgent, locale, referrer, traceId };
    }

    // Try to extract user from auth token
    if (!user) {
      try {
        const token =
          request.cookies.get('admin_token')?.value ||
          request.cookies.get('manasik_token')?.value ||
          request.cookies.get('ghadaq_token')?.value;

        if (token) {
          const decoded = verifyToken(token);
          if (decoded) {
            user = {
              userId: decoded.userId,
              email: decoded.email,
              role: decoded.role,
              name: decoded.name,
            };
          }
        }
      } catch {
        // Token invalid or expired — no user data
      }
    }
  }

  const method = request?.method;
  const url = request?.nextUrl?.pathname;

  const doc: Partial<IErrorLog> = {
    level,
    message: String(message).slice(0, 2000),
    stack: stack?.slice(0, 10000),
    source: source?.slice(0, 500),
    method,
    url: url?.slice(0, 500),
    statusCode,
    appId,
    user,
    session,
    metadata,
  };

  try {
    await connectDB();
    await ErrorLog.create(doc);
  } catch (dbErr) {
    // Never let error logging itself cause an error
    console.error('[logError] Failed to save error log to DB:', dbErr);
    console.error('[logError] Original error:', message);
  }
}

/**
 * Log an error from a caught exception, extracting the stack trace.
 */
export async function logException(
  request: NextRequest | null,
  error: unknown,
  options: Omit<LogErrorOptions, 'message' | 'stack'>,
): Promise<void> {
  const message =
    error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  await logError(request, { ...options, message, stack });
}
