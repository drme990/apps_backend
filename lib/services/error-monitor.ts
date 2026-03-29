/**
 * Pseudo-Error Monitoring Service
 *
 * In a real production environment, this should wrap Sentry or Datadog.
 * For now, it enforces structured JSON logging to stderr so log aggregators
 * (like Vercel Logs, Datadog or AWS CloudWatch) can natively index these fail states.
 */

export interface ErrorContext {
  service: string;
  operation: string;
  metadata?: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export function captureException(error: unknown, context: ErrorContext) {
  // Extract error details safely
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;
  const isErrorObject = error instanceof Error;

  const payload = {
    timestamp: new Date().toISOString(),
    event: 'ERROR_CAUGHT',
    severity: context.severity,
    service: context.service,
    operation: context.operation,
    message: errorMessage,
    stack: errorStack,
    metadata: context.metadata,
    rawError: isErrorObject ? undefined : error,
  };

  // Structured log to stderr for log aggregators to pick up instead of swallowing
  console.error(JSON.stringify(payload));

  // TODO: Add critical alerting mechanism (e.g. queue failed jobs, Slack/Discord webhook alerts)
  if (context.severity === 'critical') {
    // Notify devops or escalate immediately
    console.error(
      `[CRITICAL ALERT] ${context.service}:${context.operation} failed!`,
    );
  }
}
