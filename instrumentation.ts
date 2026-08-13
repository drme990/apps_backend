/**
 * Next.js instrumentation hook — runs once at server startup (Node.js runtime).
 *
 * Validates that all required environment variables are present before the
 * server starts handling requests. In production, missing critical variables
 * throw immediately so the deployment fails loudly rather than serving
 * broken responses silently.
 *
 * All startup logs go through the pino server logger.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { logger } from './lib/services/server-logger';

/** Variables that must be set for the application to work correctly. */
const REQUIRED_ENV_VARS: string[] = [
  'DATA_BASE_URL',
  'JWT_SECRET',
  'EASYKASH_API_KEY',
  'EASYKASH_HMAC_SECRET',
  'ALLOWED_ORIGINS',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
  'TIKTOK_PIXEL_ID',
  'TIKTOK_ACCESS_TOKEN',
];

export async function register(): Promise<void> {
  // Only run env validation in the Node.js runtime (not Edge).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length === 0) {
    logger.info(
      { event: 'startup.env_ok' },
      'All required environment variables are set.',
    );
    return;
  }

  const message = `Missing required environment variables: ${missing.join(', ')}`;

  logger.error(
    { event: 'startup.env_missing', missing },
    message,
  );

  // In production, fail fast so the deployment is rejected immediately.
  // In development/test, log a warning and continue so local dev still works
  // without a full secrets setup.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`[startup] ${message}`);
  }
}
