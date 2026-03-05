interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Clean up old entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
      if (now > entry.resetAt) {
        rateLimitMap.delete(key);
      }
    }
  },
  5 * 60 * 1000,
);

interface RateLimitOptions {
  maxAttempts: number;
  windowSeconds: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

export function checkRateLimit(
  identifier: string,
  options: RateLimitOptions = { maxAttempts: 5, windowSeconds: 15 * 60 },
): RateLimitResult {
  const now = Date.now();
  const windowMs = options.windowSeconds * 1000;
  const entry = rateLimitMap.get(identifier);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(identifier, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: options.maxAttempts - 1,
      resetInSeconds: options.windowSeconds,
    };
  }

  entry.count += 1;
  const resetInSeconds = Math.ceil((entry.resetAt - now) / 1000);

  if (entry.count > options.maxAttempts) {
    return { allowed: false, remaining: 0, resetInSeconds };
  }

  return {
    allowed: true,
    remaining: options.maxAttempts - entry.count,
    resetInSeconds,
  };
}
