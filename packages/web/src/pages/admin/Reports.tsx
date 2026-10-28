import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../../lib/api';
import {
  IconCalendar,
  IconDownload,
  IconSend,
  IconInbox,
  IconUsers,
  IconFile,
  IconChart,
} from '../../components/Icons';
import type { AdminReportResponse, AdminUserActivity } from '@email-service/shared';

type PresetKey = 'today' | 'yesterday' | '7d' | '30d' | 'this_month' | 'last_month' | 'custom';

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function toUtcDateString(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getPresetDates(preset: PresetKey): { start: string; end: string } {
  const now = new Date();
  const todayStr = toUtcDateString(now);

  switch (preset) {
    case 'today':
      return { start: todayStr, end: todayStr };
    case 'yesterday': {
      const y = new Date(now);
      y.setUTCDate(y.getUTCDate() - 1);
      const yStr = toUtcDateString(y);
      return { start: yStr, end: yStr };
    }
    case '7d': {
      const d7 = new Date(now);
      d7.setUTCDate(d7.getUTCDate() - 6);
      return { start: toUtcDateString(d7), end: todayStr };
    }
    case '30d': {
      const d30 = new Date(now);
      d30.setUTCDate(d30.getUTCDate() - 29);
      return { start: toUtcDateString(d30), end: todayStr };
    }
    case 'this_month': {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { start: toUtcDateString(first), end: todayStr };
    }
    case 'last_month': {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      return { start: toUtcDateString(first), end: toUtcDateString(last) };
    }
    case 'custom':
    default: {
      const d30 = new Date(now);
      d30.setUTCDate(d30.getUTCDate() - 29);
      return { start: toUtcDateString(d30), end: todayStr };
    }
  }
}

export default function AdminReports() {
  const [preset, setPreset] = useState<PresetKey>('30d');
  const initialDates = useMemo(() => getPresetDates('30d'), []);
  const [startDate, setStartDate] = useState(initialDates.start);
  const [endDate, setEndDate] = useState(initialDates.end);
  const [draftDates, setDraftDates] = useState(initialDates);
  const [userSearch, setUserSearch] = useState('');
  const [userSortBy, setUserSortBy] = useState<'total' | 'sent' | 'received' | 'storage'>('total');

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['admin-reports', startDate, endDate],
    queryFn: ({ signal }) => adminApi.getReports({ startDate, endDate }, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const report: AdminReportResponse | undefined = data?.data;
  const summary = report?.summary;
  const daily = report?.daily || [];
  const users = report?.users || [];

  const handleSelectPreset = (p: PresetKey) => {
    setPreset(p);
    if (p !== 'custom') {
      const { start, end } = getPresetDates(p);
      setDraftDates({start,end});
      setStartDate(start);
      setEndDate(end);
    }
  };

  const handleCustomDateChange = (type: 'start' | 'end', val: string) => {
    setPreset('custom');
    setDraftDates(current => ({...current,[type]:val}));
  };

  // Filtered & Sorted Users
  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase().trim();
    let list = users.filter((u: AdminUserActivity) => {
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        u.displayName.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q)
      );
    });

    list = [...list].sort((a, b) => {
      switch (userSortBy) {
        case 'sent':
          return b.sent - a.sent;
        case 'received':
          return b.received - a.received;
        case 'storage':
          return b.storageUsedBytes - a.storageUsedBytes;
        case 'total':
        default:
          return b.totalEmails - a.totalEmails;
      }
    });

    return list;
  }, [users, userSearch, userSortBy]);

  // Max daily volume for chart scaling
  const maxDailyVolume = useMemo(() => {
    if (daily.length === 0) return 1;
    return Math.max(1, ...daily.map((d) => Math.max(d.sent, d.received, d.totalEmails)));
  }, [daily]);

  // Export CSV
  const handleExportCSV = () => {
    if (!report) return;

    const rows: string[] = [];
    rows.push(`"Email Service Report: ${startDate} to ${endDate}"`);
    rows.push('"Dates use UTC. Storage represents retained items, not historical storage growth."');
    if (report.freshness) {
      rows.push(`"Oldest mailbox update","${report.freshness.updatedAt || 'Awaiting reports'}"`);
      rows.push(`"Missing mailboxes",${report.freshness.missingMailboxes}`);
      rows.push(`"Overdue mailboxes",${report.freshness.staleMailboxes}`);
      if(report.freshness.historicalBaselineIncomplete) rows.push('"Earlier activity is a retained-mail baseline and excludes previously deleted messages."');
    }
    rows.push('');

    // 1. Summary
    rows.push('"--- Summary ---"');
    rows.push('"Metric","Value"');
    rows.push(`"Total Sent",${summary?.totalSent ?? 0}`);
    rows.push(`"Total Received",${summary?.totalReceived ?? 0}`);
    rows.push(`"Total Emails",${summary?.totalEmails ?? 0}`);
    rows.push(`"Email Bodies Storage (Bytes)",${summary?.emailBytes ?? 0}`);
    rows.push(`"Total Attachments",${summary?.totalAttachments ?? 0}`);
    rows.push(`"Attachment Storage (Bytes)",${summary?.attachmentBytes ?? 0}`);
    rows.push(`"Total Shared Files",${summary?.totalSharedFiles ?? 0}`);
    rows.push(`"Shared Files Storage (Bytes)",${summary?.sharedFilesBytes ?? 0}`);
    rows.push(`"Total Retained Storage (Bytes)",${summary?.totalStorageBytes ?? 0}`);
    rows.push(`"Active Users in Period",${summary?.activeUsers ?? 0}`);
    rows.push('');

    // 2. Daily Breakdown
    rows.push('"--- Daily Breakdown ---"');
    rows.push('"Date","Sent","Received","Total Emails","Retained Storage (Bytes)"');
    for (const d of daily) {
      rows.push(`"${d.date}",${d.sent},${d.received},${d.totalEmails},${d.storageBytes ?? d.attachmentBytes}`);
    }
    rows.push('');

    // 3. User Activity
    // User-supplied text is quoted, and a leading = + - @ (or tab/CR) is
    // prefixed with ' so a spreadsheet does not run it as a formula.
    const cell = (v: string) => '"' + (/^[=+@\-\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"';
    rows.push('"--- User Activity ---"');
    rows.push('"Email","Display Name","Role","Sent","Received","Total Emails","Storage (Bytes)"');
    for (const u of users) {
      rows.push(
        `${cell(u.email)},${cell(u.displayName)},${cell(u.role)},${u.sent},${u.received},${u.totalEmails},${u.storageUsedBytes}`
      );
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `email_report_${startDate}_to_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="admin-page">
      <div className="admin-header" style={{ flexWrap: 'wrap', gap: 'var(--space-4)' }}>
        <div>
          <h1>Reports & Analytics</h1>
          <p className="page-subtitle">Track email traffic, user activity, and storage trends</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExportCSV}
            disabled={isLoading || !report}
          >
            <IconDownload size={16} /> Export CSV
          </button>
        </div>
      </div>

      {isError && (
        <div className="login-error" style={{ marginBottom: 'var(--space-4)' }}>
          {(error as Error).message}
        </div>
      )}

      {/* Filter Toolbar */}
      <div
        style={{
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-4)',
          marginBottom: 'var(--space-6)',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
        }}
      >
        {/* Preset Buttons */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          {[
            { key: 'today', label: 'Today' },
            { key: 'yesterday', label: 'Yesterday' },
            { key: '7d', label: 'Last 7 Days' },
            { key: '30d', label: 'Last 30 Days' },
            { key: 'this_month', label: 'This Month' },
            { key: 'last_month', label: 'Last Month' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`btn btn-sm ${preset === item.key ? 'btn-primary' : 'btn-ghost'}`}
              style={{
                borderRadius: 'var(--radius-full)',
                padding: 'var(--space-1) var(--space-3)',
                fontSize: 'var(--font-size-xs)',
              }}
              onClick={() => handleSelectPreset(item.key as PresetKey)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Date Pickers */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <IconCalendar size={18} color="var(--color-text-secondary)" />
          <input
            type="date"
            aria-label="Start date"
            value={draftDates.start}
            onChange={(e) => handleCustomDateChange('start', e.target.value)}
            className="input-sm"
            style={{
              padding: '6px 10px',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
              fontSize: 'var(--font-size-sm)',
            }}
          />
          <span style={{ color: 'var(--color-text-tertiary)' }}>to</span>
          <input
            type="date"
            aria-label="End date"
            value={draftDates.end}
            onChange={(e) => handleCustomDateChange('end', e.target.value)}
            className="input-sm"
            style={{
              padding: '6px 10px',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--color-text-primary)',
              fontSize: 'var(--font-size-sm)',
            }}
          />
          <button type="button" className="btn btn-sm" disabled={!draftDates.start || !draftDates.end || draftDates.start > draftDates.end}
            onClick={() => { setStartDate(draftDates.start); setEndDate(draftDates.end); }}>Apply dates</button>
        </div>
      </div>
      {report?.freshness && <div role="status" style={{marginBottom:'var(--space-4)'}}>
        <p>Report dates use UTC. Oldest mailbox update: {report.freshness.updatedAt ? new Date(report.freshness.updatedAt).toLocaleString() : 'Awaiting initial reports'}.</p>
        {(report.freshness.missingMailboxes > 0 || report.freshness.staleMailboxes > 0) && <p>
          Partial or delayed data: {report.freshness.missingMailboxes} mailboxes awaiting reports; {report.freshness.staleMailboxes} overdue updates. Refresh after background updates finish.
        </p>}
        {report.freshness.historicalBaselineIncomplete && <p>Earlier activity is based on retained mail. Messages deleted before activity tracking began cannot be included.</p>}
        <p>Sent counts messages accepted by the sending provider, not confirmed recipient delivery. Storage shows retained items dated within the selected period.</p>
      </div>}

      {/* Summary Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="stat-value">{!summary ? '—' : summary?.totalEmails ?? 0}</div>
            <span style={{ padding: 8, background: 'rgba(108, 99, 255, 0.1)', borderRadius: '50%' }}>
              <IconChart size={20} color="var(--color-accent)" />
            </span>
          </div>
          <div className="stat-label">Total Emails Processed</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="stat-value">{!summary ? '—' : summary?.totalSent ?? 0}</div>
            <span style={{ padding: 8, background: 'rgba(16, 185, 129, 0.1)', borderRadius: '50%' }}>
              <IconSend size={20} color="#10b981" />
            </span>
          </div>
          <div className="stat-label">Emails Sent</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="stat-value">{!summary ? '—' : summary?.totalReceived ?? 0}</div>
            <span style={{ padding: 8, background: 'rgba(59, 130, 246, 0.1)', borderRadius: '50%' }}>
              <IconInbox size={20} color="#3b82f6" />
            </span>
          </div>
          <div className="stat-label">Emails Received</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="stat-value">
              {!summary ? '—' : formatBytes(summary?.totalStorageBytes ?? 0)}
            </div>
            <span style={{ padding: 8, background: 'rgba(236, 72, 153, 0.1)', borderRadius: '50%' }}>
              <IconFile size={20} color="#ec4899" />
            </span>
          </div>
          <div className="stat-label">Retained Storage in Period</div>
          {!isLoading && summary && (
            <div
              style={{
                fontSize: '11px',
                color: 'var(--color-text-tertiary)',
                marginTop: 'var(--space-2)',
                lineHeight: 1.3,
              }}
            >
              Bodies: {formatBytes(summary.emailBytes || 0)} · Attachments: {formatBytes(summary.attachmentBytes || 0)} · Shared: {formatBytes(summary.sharedFilesBytes || 0)}
            </div>
          )}
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="stat-value">
              {!summary ? '—' : (summary?.totalAttachments ?? 0) + (summary?.totalSharedFiles ?? 0)}
            </div>
            <span style={{ padding: 8, background: 'rgba(245, 158, 11, 0.1)', borderRadius: '50%' }}>
              <IconFile size={20} color="#f59e0b" />
            </span>
          </div>
          <div className="stat-label">Files & Attachments</div>
        </div>

        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div className="stat-value">{!summary ? '—' : summary?.activeUsers ?? 0}</div>
            <span style={{ padding: 8, background: 'rgba(139, 92, 246, 0.1)', borderRadius: '50%' }}>
              <IconUsers size={20} color="#8b5cf6" />
            </span>
          </div>
          <div className="stat-label">Active Users in Period</div>
        </div>
      </div>

      {/* Daily Activity Chart & Table */}
      <div style={{ marginBottom: 'var(--space-8)' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-3)',
          }}
        >
          <h2 style={{ fontSize: 'var(--font-size-xl)' }}>Daily Activity Breakdown</h2>
          <div style={{ display: 'flex', gap: 'var(--space-4)', fontSize: 'var(--font-size-xs)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, background: '#10b981', borderRadius: 2 }} />
              Sent
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, background: '#3b82f6', borderRadius: 2 }} />
              Received
            </span>
          </div>
        </div>

        {/* Visual Bar Chart */}
        {daily.length > 0 && (
          <div
            style={{
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--space-4) var(--space-4) var(--space-2) var(--space-4)',
              marginBottom: 'var(--space-4)',
              overflowX: 'auto',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 'var(--space-2)',
                minWidth: daily.length * 40,
                height: 160,
                paddingBottom: 24,
                borderBottom: '1px solid var(--color-border)',
                position: 'relative',
              }}
            >
              {daily.map((d) => {
                const sentH = Math.max(4, Math.round((d.sent / maxDailyVolume) * 120));
                const recH = Math.max(4, Math.round((d.received / maxDailyVolume) * 120));
                return (
                  <div
                    key={d.date}
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      position: 'relative',
                    }}
                    title={`${d.date}\nSent: ${d.sent}\nReceived: ${d.received}\nTotal: ${d.totalEmails}\nStorage: ${formatBytes(d.storageBytes ?? d.attachmentBytes)}`}
                  >
                    <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 120 }}>
                      <div
                        style={{
                          width: 12,
                          height: sentH,
                          background: '#10b981',
                          borderRadius: '3px 3px 0 0',
                          transition: 'height 0.2s',
                        }}
                      />
                      <div
                        style={{
                          width: 12,
                          height: recH,
                          background: '#3b82f6',
                          borderRadius: '3px 3px 0 0',
                          transition: 'height 0.2s',
                        }}
                      />
                    </div>
                    <span
                      style={{
                        position: 'absolute',
                        bottom: -22,
                        fontSize: '10px',
                        color: 'var(--color-text-tertiary)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {d.date.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Daily Breakdown Table */}
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: 'center' }}>Sent</th>
                <th style={{ textAlign: 'center' }}>Received</th>
                <th style={{ textAlign: 'center' }}>Total</th>
                <th style={{ textAlign: 'right' }}>Retained Storage</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
                    <span className="loading-spinner" style={{ width: 24, height: 24 }} />
                  </td>
                </tr>
              ) : daily.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
                    No email activity recorded for the selected date range.
                  </td>
                </tr>
              ) : (
                daily.map((d) => (
                  <tr key={d.date}>
                    <td className="cell-strong">{d.date}</td>
                    <td style={{ textAlign: 'center', color: '#10b981', fontWeight: 600 }}>{d.sent}</td>
                    <td style={{ textAlign: 'center', color: '#3b82f6', fontWeight: 600 }}>{d.received}</td>
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>{d.totalEmails}</td>
                    <td style={{ textAlign: 'right', fontSize: 'var(--font-size-sm)' }}>
                      {formatBytes(d.storageBytes ?? d.attachmentBytes)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-User Activity Breakdown */}
      <div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 'var(--space-4)',
            gap: 'var(--space-3)',
          }}
        >
          <div>
            <h2 style={{ fontSize: 'var(--font-size-xl)' }}>User Activity Breakdown</h2>
            <p className="page-subtitle" style={{ margin: 0 }}>
              Per-user volume and retained storage for items dated between {startDate} and {endDate}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <input
              type="text"
              placeholder="Search user..."
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              style={{
                padding: '6px 12px',
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                minWidth: 200,
              }}
            />
            <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                Sort:
              </span>
              {(['total', 'sent', 'received', 'storage'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`btn btn-xs ${userSortBy === s ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ textTransform: 'capitalize', fontSize: '11px' }}
                  onClick={() => setUserSortBy(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th style={{ textAlign: 'center' }}>Sent</th>
                <th style={{ textAlign: 'center' }}>Received</th>
                <th style={{ textAlign: 'center' }}>Total Emails</th>
                <th style={{ textAlign: 'right' }}>Retained Storage</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
                    <span className="loading-spinner" style={{ width: 24, height: 24 }} />
                  </td>
                </tr>
              ) : filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
                    No user activity found matching your filter.
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="cell-strong">
                      <div>{u.displayName}</div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-tertiary)' }}>
                        {u.email}
                      </div>
                    </td>
                    <td>
                      <span className={`role-badge ${u.role}`}>{u.role}</span>
                    </td>
                    <td style={{ textAlign: 'center', color: '#10b981', fontWeight: 600 }}>{u.sent}</td>
                    <td style={{ textAlign: 'center', color: '#3b82f6', fontWeight: 600 }}>{u.received}</td>
                    <td style={{ textAlign: 'center', fontWeight: 600 }}>{u.totalEmails}</td>
                    <td style={{ textAlign: 'right', fontSize: 'var(--font-size-sm)' }}>
                      {formatBytes(u.storageUsedBytes)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
