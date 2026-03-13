/**
 * In-memory sliding-window rate limiter.
 *
 * Works in long-running Node.js processes and warm serverless instances.
 * For multi-replica or fully-stateless deployments, swap the store for
 * Redis / Upstash to enforce limits across all instances.
 *
 * Usage:
 *   const result = rateLimit(`checkout:${ip}`, 5, 60_000);
 *   if (!result.allowed) return 429;
 */

interface RateEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateEntry>();

// Periodically purge expired entries to avoid unbounded memory growth.
// Only runs in environments that keep the module alive between requests.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, 60_000);
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * @param key      Unique key for this (action, identity) pair, e.g. `checkout:1.2.3.4`
 * @param limit    Max requests allowed within the window
 * @param windowMs Window duration in milliseconds
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return {
    allowed: true,
    remaining: limit - entry.count,
    resetAt: entry.resetAt,
  };
}

/** Extract the best-available client IP from a Next.js request. */
export function getClientIp(request: Request): string {
  const forwarded = (request.headers as Headers).get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = (request.headers as Headers).get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}
