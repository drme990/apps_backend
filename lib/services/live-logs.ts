type LiveLogLevel = 'info' | 'warn' | 'error';

export interface LiveLogEntry {
  ts: string;
  level: LiveLogLevel;
  event: string;
  source: 'request' | 'error';
  message?: string;
  [key: string]: unknown;
}

const MAX_LOGS = 500;
const liveLogs: LiveLogEntry[] = [];

function serializeConsoleArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

function tryParseStructuredLog(entry: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(entry) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'event' in parsed) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function shouldIgnoreLog(
  message: string,
  structured: Record<string, unknown> | null,
): boolean {
  const structuredPath =
    typeof structured?.path === 'string' ? structured.path : '';

  if (structuredPath.startsWith('/api/logs')) {
    return true;
  }

  const normalizedMessage = message.toLowerCase();
  return normalizedMessage.includes('/api/logs');
}

export function pushLiveLog(entry: LiveLogEntry): void {
  liveLogs.unshift(entry);

  if (liveLogs.length > MAX_LOGS) {
    liveLogs.length = MAX_LOGS;
  }
}

export function getLiveLogs(limit: number = 100): LiveLogEntry[] {
  const safeLimit = Math.max(1, Math.min(limit, MAX_LOGS));
  return liveLogs.slice(0, safeLimit);
}

export function clearLiveLogs(): void {
  liveLogs.length = 0;
}

export function persistLiveLog(entry: LiveLogEntry): void {
  void import('@/lib/models/TerminalLog').then(
    async ({ default: TerminalLog }) => {
      try {
        if (entry.ts && entry.event) {
          await TerminalLog.create({
            ts: entry.ts,
            level: entry.level,
            event: entry.event,
            source: entry.source,
            message: entry.message,
            payload: entry,
          });
        }
      } catch {
        // Best-effort persistence only.
      }
    },
  );
}

export function captureTerminalLog(level: LiveLogLevel, args: unknown[]): void {
  const message = serializeConsoleArgs(args);
  const structured = message ? tryParseStructuredLog(message) : null;

  if (shouldIgnoreLog(message, structured)) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    level,
    event:
      typeof structured?.event === 'string'
        ? structured.event
        : level === 'error'
          ? 'console.error'
          : level === 'warn'
            ? 'console.warn'
            : 'console.log',
    source: 'request' as const,
    message,
    ...(structured || {}),
  } satisfies LiveLogEntry;

  pushLiveLog(entry);
  persistLiveLog(entry);
}
