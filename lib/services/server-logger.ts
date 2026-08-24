/**
 * Server Logger — pino-based structured logging for the backend.
 *
 * Two modes:
 *  - **Development**: pretty-printed colorized output to the terminal
 *    (via pino-pretty transport).
 *  - **Production** (VPS / Vercel / Docker): newline-delimited JSON to
 *    stdout only. Docker / Vercel / PM2 all capture stdout and surface
 *    it in their respective dashboards. No file-based transport is
 *    used in production because the container/filesystem may be
 *    read-only or the process may lack write permissions.
 *
 * The singleton `logger` instance is imported everywhere:
 *   import { logger } from '@/lib/services/server-logger';
 *   logger.info({ event: 'checkout.initiated', orderId }, 'checkout started');
 *   logger.error({ err, service: 'PaymentRoute' }, 'payment failed');
 *
 * Next.js's default request logging is suppressed separately in
 * next.config.ts + instrumentation.ts — this logger is the single
 * source of truth for server-side output.
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const LOG_LEVEL = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

/**
 * Build the appropriate pino transport based on environment.
 *
 * - Dev → pino-pretty (readable terminal output)
 * - Production → undefined (plain pino, JSON to stdout; Docker /
 *   Vercel / PM2 capture stdout)
 */
function buildTransport(): pino.TransportTargetOptions | pino.TransportMultiOptions | undefined {
  if (!isProduction) {
    // Dev: pretty console output
    return {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    };
  }

  // Production: no transport — pino writes JSON to stdout directly.
  // Docker / Vercel / PM2 all capture stdout. No file transport is
  // used because the filesystem may be read-only or the process may
  // lack write permissions (non-root user in Docker).
  return undefined;
}

const logger = pino({
  level: LOG_LEVEL,
  base: { env: process.env.NODE_ENV || 'development' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: buildTransport(),
  // Redact sensitive fields from logs
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.cookies',
      'headers.authorization',
      'headers.cookie',
      'cookies',
      '*.password',
      '*.token',
      '*.secret',
      '*.apiKey',
      '*.accessToken',
      '*.refreshToken',
    ],
    censor: '[REDACTED]',
  },
});

export default logger;
export { logger };
