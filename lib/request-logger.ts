/**
 * Structured request/event logger.
 *
 * Routes all log output through the pino server logger
 * (lib/services/server-logger.ts). In development, logs are
 * pretty-printed to the terminal. In production on VPS, they go to
 * stdout (JSON) + rotating log files. On Vercel, stdout only.
 *
 * Usage:
 *   import { log } from '@/lib/request-logger';
 *   log('info', 'checkout.initiated', { orderId, traceId });
 */

import { logger } from './services/server-logger';

type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  traceId?: string;
  [key: string]: unknown;
}

export function log(
  level: LogLevel,
  event: string,
  meta?: Record<string, unknown>,
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };

  // pino expects the message as the second arg and context as the first
  // strip `level` and `ts` from the entry — pino adds its own timestamp + level
  const { level: _l, ts: _t, ...context } = entry;
  void _l;
  void _t;
  logger[level](context, event);
}
