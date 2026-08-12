/**
 * Error Monitoring Service
 *
 * Captures exceptions and routes them through the pino server logger.
 * In production, logs are written to stdout (JSON) + rotating log files.
 * In development, logs are pretty-printed to the terminal.
 *
 * The ActivityLog (MongoDB) is separate — it tracks admin user actions.
 * This service tracks server-side errors and operational failures.
 */

import { logger } from './server-logger';

export interface ErrorContext {
  service: string;
  operation: string;
  metadata?: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export function captureException(error: unknown, context: ErrorContext) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  const payload = {
    event: 'error.caught',
    severity: context.severity,
    service: context.service,
    operation: context.operation,
    message: errorMessage,
    stack: errorStack,
    metadata: context.metadata,
    rawError: error instanceof Error ? undefined : error,
  };

  // Route through pino at the appropriate level
  const level =
    context.severity === 'critical' ? 'fatal' :
      context.severity === 'high' ? 'error' :
        context.severity === 'medium' ? 'warn' : 'info';

  logger[level](payload, `${context.service}:${context.operation} failed`);

  // Critical alerts get an additional explicit fatal log
  if (context.severity === 'critical') {
    logger.fatal(
      { service: context.service, operation: context.operation },
      `[CRITICAL ALERT] ${context.service}:${context.operation} failed!`,
    );
  }
}
