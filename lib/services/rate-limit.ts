import RateLimit from '@/lib/models/RateLimit';
import { connectDB } from '@/lib/db';

interface RateLimitOptions {
  maxAttempts: number;
  windowSeconds: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
}

export async function checkRateLimit(
  identifier: string,
  options: RateLimitOptions = { maxAttempts: 5, windowSeconds: 15 * 60 },
): Promise<RateLimitResult> {
  await connectDB();

  const now = new Date();
  const windowMs = options.windowSeconds * 1000;

  try {
    const entry = await RateLimit.findOneAndUpdate(
      { identifier },
      {
        $setOnInsert: { resetAt: new Date(now.getTime() + windowMs) },
        $inc: { count: 1 },
      },
      {
        upsert: true,
        returnDocument: 'after',
      },
    );

    const resetInSeconds = Math.max(
      0,
      Math.ceil((entry!.resetAt.getTime() - now.getTime()) / 1000),
    );

    if (entry!.count > options.maxAttempts) {
      return { allowed: false, remaining: 0, resetInSeconds };
    }

    return {
      allowed: true,
      remaining: options.maxAttempts - entry!.count,
      resetInSeconds,
    };
  } catch (error) {
    console.error('Rate limit DB error, falling back to allow:', error);
    return {
      allowed: true, // Fail open so users aren't locked out if DB rate-limit fails randomly
      remaining: options.maxAttempts - 1,
      resetInSeconds: options.windowSeconds,
    };
  }
}
