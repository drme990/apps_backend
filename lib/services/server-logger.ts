/**
 * Server Logger — pino-based structured logging for the backend.
 *
 * Two modes:
 *  - **Development**: pretty-printed colorized output to the terminal
 *    (via pino-pretty) so logs are readable while you work.
 *  - **Production**: newline-delimited JSON to stdout (for log aggregators
 *    like Datadog, CloudWatch, or `journalctl`) **and** rotating log files
 *    via pino-roll (logs/app.log, rotated daily, 10 files kept).
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
const LOG_DIR = process.env.LOG_DIR || 'logs';
const LOG_LEVEL = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

/** Build the appropriate pino transport based on environment. */
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

  // Production: JSON to stdout + rotating file
  return {
    targets: [
      // stdout — for log aggregators / journalctl
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
