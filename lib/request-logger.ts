/**
 * Structured request/event logger.
 *
 * Outputs newline-delimited JSON so Vercel Log Drain, Datadog,
 * and any standard log aggregator can parse it automatically.
 *
 * Usage:
 *   import { log } from '@/lib/request-logger';
 *   log('info', 'checkout.initiated', { orderId, traceId });
 */

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

  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}
