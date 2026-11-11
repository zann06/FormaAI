import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import type { UsageEvent, UsageSummary } from '../lib/types';
import { PageHeader, ErrorState, Spinner, EmptyState } from '../components/Feedback';
import { Badge } from '../components/StatusBadges';
import { formatDate, formatNumber } from '../lib/format';

export function UsagePage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.get<{ events: UsageEvent[]; summary: UsageSummary }>('/api/usage');
      setEvents(result.events);
      setSummary(result.summary);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Usage"
        description="AI requests made with your own provider keys, over the last 30 days."
      />

      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!error && !summary && (
        <div className="card p-6">
          <Spinner label="Loading usage…" />
        </div>
      )}

      {summary && (
        <>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Requests" value={formatNumber(summary.totals.requests)} />
            <Stat label="Succeeded" value={formatNumber(summary.totals.successes)} />
            <Stat label="Input tokens" value={formatNumber(summary.totals.inputTokens)} />
            <Stat label="Output tokens" value={formatNumber(summary.totals.outputTokens)} />
          </dl>

          {summary.totals.failures > 0 && (
            <p className="mt-3 text-sm text-amber-700">
              {formatNumber(summary.totals.failures)} failed request(s)
              {summary.totals.fallbacks > 0 ? `, ${formatNumber(summary.totals.fallbacks)} used a fallback provider` : ''}.
            </p>
          )}

          {summary.byModel.length > 0 && (
            <div className="card mt-6 overflow-hidden">
              <table className="w-full text-sm">
                <caption className="sr-only">Usage grouped by model</caption>
                <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Model
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Provider
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Requests
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Tokens
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {summary.byModel.map((row, index) => (
                    <tr key={`${row.model ?? 'unknown'}-${row.providerType}-${index}`}>
                      <td className="px-4 py-2 font-medium text-ink-800">{row.model ?? '—'}</td>
                      <td className="px-4 py-2 text-ink-600">{row.providerType}</td>
                      <td className="px-4 py-2 text-right text-ink-700">{formatNumber(row.requests)}</td>
                      <td className="px-4 py-2 text-right text-ink-700">
                        {formatNumber(row.inputTokens + row.outputTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="mb-3 mt-8 text-lg font-semibold text-ink-900">Recent requests</h2>
          {events && events.length === 0 && (
            <EmptyState
              title="No AI requests yet"
              description="Generate a section in one of your projects and the request will appear here."
            />
          )}
          {events && events.length > 0 && (
            <ul className="card divide-y divide-ink-100">
              {events.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <Badge tone={event.status === 'success' ? 'green' : 'red'}>
                    {event.status === 'success' ? 'Success' : 'Failed'}
                  </Badge>
                  <span className="font-medium text-ink-800">{event.operation}</span>
                  <span className="text-ink-500">{event.model}</span>
                  {event.errorCode && <span className="text-xs text-red-600">{event.errorCode}</span>}
                  <span className="ml-auto text-xs text-ink-400">
                    {formatNumber((event.inputTokens ?? 0) + (event.outputTokens ?? 0))} tokens ·{' '}
                    {formatDate(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold text-ink-900">{value}</dd>
    </div>
  );
}
