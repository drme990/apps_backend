'use client';

import { useEffect, useMemo, useState } from 'react';

type LogEntry = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  source: 'request' | 'error';
  message?: string;
  kind?: 'live';
  service?: string;
  operation?: string;
  details?: string;
  payload?: Record<string, unknown>;
};

const SESSION_KEY = 'backend-logs-password';

function formatTimestamp(value: string): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function levelStyle(level: LogEntry['level']): string {
  if (level === 'error')
    return 'bg-gradient-to-r from-red-900/40 to-red-900/20 border-red-500/40 text-red-100';
  if (level === 'warn')
    return 'bg-gradient-to-r from-amber-900/40 to-amber-900/20 border-amber-500/40 text-amber-100';
  return 'bg-gradient-to-r from-blue-900/40 to-blue-900/20 border-blue-500/40 text-blue-100';
}

function levelBadgeStyle(level: LogEntry['level']): string {
  if (level === 'error')
    return 'bg-red-500/20 border-red-500/30 text-red-300 font-semibold';
  if (level === 'warn')
    return 'bg-amber-500/20 border-amber-500/30 text-amber-300 font-semibold';
  return 'bg-blue-500/20 border-blue-500/30 text-blue-300 font-semibold';
}

export default function LogsPage() {
  const [password, setPassword] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const storedPassword = window.sessionStorage.getItem(SESSION_KEY);
    if (storedPassword) {
      setPassword(storedPassword);
      setUnlocked(true);
    }
  }, []);

  async function loadLogs(secret: string): Promise<void> {
    if (!secret) {
      setError('Enter the logs password first.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/logs?limit=80', {
        headers: {
          'x-logs-password': secret,
        },
        cache: 'no-store',
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { logs: LogEntry[] };
        error?: string;
      };

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to load logs');
      }

      setLogs(payload.data?.logs || []);
      setUnlocked(true);
      window.sessionStorage.setItem(SESSION_KEY, secret);
    } catch (loadError) {
      setLogs([]);
      setUnlocked(false);
      window.sessionStorage.removeItem(SESSION_KEY);
      setError(
        loadError instanceof Error ? loadError.message : 'Failed to load logs',
      );
    } finally {
      setLoading(false);
    }
  }

  async function deleteLogs(): Promise<void> {
    if (!password) return;

    const confirmed = window.confirm(
      'Delete all terminal logs from the database and current session buffer?',
    );
    if (!confirmed) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/logs', {
        method: 'DELETE',
        headers: {
          'x-logs-password': password,
        },
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: string;
      };

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to delete logs');
      }

      setLogs([]);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Failed to delete logs',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!unlocked || !password) return;

    void loadLogs(password);
    const interval = window.setInterval(() => {
      void loadLogs(password);
    }, 4000);

    return () => window.clearInterval(interval);
  }, [unlocked, password]);

  const visibleLogs = useMemo(() => logs.slice(0, 80), [logs]);

  return (
    <main className="min-h-screen bg-neutral-950 bg-linear-to-br from-neutral-950 via-neutral-900 to-neutral-950 text-neutral-100">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        {/* Header Section */}
        <div className="space-y-4 rounded-2xl border border-white/10 bg-linear-to-br from-white/8 via-white/4 to-transparent p-8 shadow-2xl shadow-black/50 backdrop-blur-xl">
          <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
            <div className="flex-1">
              <p className="text-xs uppercase tracking-[0.3em] text-neutral-400 font-medium">
                Real-time Monitoring
              </p>
              <h1 className="mt-3 text-4xl font-bold bg-linear-to-r from-white via-white to-neutral-400 bg-clip-text text-transparent">
                Backend Logs
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-neutral-400">
                Live terminal feed from your backend server. Auto-refreshes
                every 4 seconds.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-neutral-300">
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse"></div>
              <span>{visibleLogs.length} entries</span>
            </div>
          </div>

          {!unlocked ? (
            <form
              className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void loadLogs(password);
              }}
            >
              <div className="flex-1 sm:flex-none">
                <label className="block text-xs uppercase tracking-wider text-neutral-400 mb-2">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter logs password"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition placeholder:text-neutral-600 focus:border-blue-400/50 focus:bg-black/60 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl bg-linear-to-r from-blue-600 to-blue-500 px-6 py-3 font-semibold text-white transition hover:from-blue-500 hover:to-blue-400 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/20"
              >
                {loading ? 'Unlocking...' : 'Unlock'}
              </button>
            </form>
          ) : (
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void deleteLogs()}
                  disabled={loading}
                  className="rounded-xl border-2 border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-200 transition hover:border-red-500/60 hover:bg-red-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  🗑️ Delete All
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUnlocked(false);
                    setLogs([]);
                    window.sessionStorage.removeItem(SESSION_KEY);
                  }}
                  className="rounded-xl border border-white/20 bg-white/5 px-4 py-2.5 text-sm font-semibold text-neutral-200 transition hover:bg-white/10 hover:border-white/30"
                >
                  🔒 Lock
                </button>
              </div>
              <span className="text-xs text-neutral-500 italic">
                Password saved for this session
              </span>
            </div>
          )}

          {error ? (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2">
              <span className="text-lg">⚠️</span>
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        {/* Logs Section */}
        {unlocked ? (
          <section className="space-y-4">
            {visibleLogs.length === 0 ? (
              <div className="rounded-2xl border-2 border-dashed border-white/10 bg-white/3 p-16 text-center">
                <div className="text-5xl mb-4">📭</div>
                <p className="text-neutral-400">No logs available yet.</p>
                <p className="text-xs text-neutral-500 mt-2">
                  Logs will appear here as they are generated
                </p>
              </div>
            ) : (
              visibleLogs.map((entry, index) => (
                <article
                  key={`${entry.ts}-${entry.event}-${index}`}
                  className={`rounded-2xl border border-white/10 transition-all duration-300 hover:border-white/20 ${levelStyle(entry.level)} p-5 shadow-md hover:shadow-lg hover:shadow-black/40`}
                >
                  <div className="flex flex-col gap-4">
                    {/* Log Header */}
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                          <span
                            className={`rounded-lg border px-3 py-1 text-xs font-bold uppercase tracking-wide ${levelBadgeStyle(entry.level)}`}
                          >
                            {entry.level}
                          </span>
                          <span className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-neutral-400">
                            {entry.kind || entry.source}
                          </span>
                          <span className="text-xs text-neutral-500 font-mono">
                            {formatTimestamp(entry.ts)}
                          </span>
                        </div>
                        <h2 className="text-base font-bold text-white wrap-break-word">
                          {entry.event}
                        </h2>
                      </div>
                      {(entry.service || entry.operation) && (
                        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-400 whitespace-nowrap">
                          {entry.service ? `${entry.service} • ` : ''}
                          {entry.operation || entry.source}
                        </div>
                      )}
                    </div>

                    {/* Log Content */}
                    <pre className="overflow-x-auto rounded-xl border border-white/5 bg-black/60 p-4 text-xs leading-relaxed text-neutral-300 font-mono max-h-48">
                      {JSON.stringify(entry, null, 2)}
                    </pre>
                  </div>
                </article>
              ))
            )}
          </section>
        ) : null}

        {/* Footer Info */}
        {unlocked && visibleLogs.length > 0 && (
          <div className="text-center text-xs text-neutral-500 py-4 border-t border-white/5">
            Showing {visibleLogs.length} most recent entries • Updates
            automatically every 4s
          </div>
        )}
      </div>
    </main>
  );
}
