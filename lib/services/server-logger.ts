/**
 * Server Logger — pino-based structured logging for the backend.
 *
 * Three modes:
 *  - **Development**: pretty-printed colorized output to the terminal
 *    (via pino-pretty transport).
 *  - **Production on VPS**: newline-delimited JSON to stdout **and**
 *    rotating log files via pino-roll (logs/app.log, rotated daily,
 *    10 files kept). PM2 also captures stdout.
 *  - **Production on Vercel**: newline-delimited JSON to stdout only.
 *    Vercel captures stdout and surfaces it in the dashboard. pino-roll
 *    is skipped because it spawns worker threads that Vercel's
 *    serverless runtime cannot load.
 *
 * Detection: Vercel sets `VERCEL=1` automatically. We check that env
 * var to decide whether file-based transports are safe to use.
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
/** Vercel sets this to "1" on all deployments. */
const isVercel = process.env.VERCEL === '1';
const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

/**
 * Build the appropriate pino transport based on environment.
 *
 * - Dev → pino-pretty (readable terminal output)
 * - Vercel prod → undefined (plain pino, JSON to stdout; Vercel
 *   captures it. Worker-thread transports don't work on serverless.)
 * - VPS prod → pino/file (stdout) + pino-roll (rotating daily files)
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

  // Vercel: no transport — pino writes JSON to stdout directly.
  // Vercel captures stdout and surfaces it in the dashboard.
  // pino-roll uses worker threads which Vercel can't load.
  if (isVercel) {
    return undefined;
  }

  // VPS production: JSON to stdout + rotating file
  return {
    targets: [
      // stdout — for log aggregators / journalctl / PM2
      {
        target: 'pino/file',
        level: LOG_LEVEL as pino.LevelWithSilent,
        options: {},
      },
      // Rotating file — daily rotation, keep 10 files
      {
        target: 'pino-roll',
        level: LOG_LEVEL as pino.LevelWithSilent,
        options: {
          file: `${LOG_DIR}/app.log`,
          frequency: 'daily',
          mkdir: true,
          limit: { count: 10 },
          size: '100m',
        },
      },
    ],
  };
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
