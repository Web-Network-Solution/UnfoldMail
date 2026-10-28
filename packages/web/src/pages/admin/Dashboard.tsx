import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adminApi } from '../../lib/api';
import { useAuthStore } from '../../stores';
import { IconUsers, IconFolderCog, IconChart } from '../../components/Icons';

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export default function AdminDashboard() {
  const user = useAuthStore((state) => state.user);
  const isSuperAdmin = user?.role === 'super_admin';
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin-stats', user?.id, user?.role],
    queryFn: () => adminApi.getStats(),
    enabled: user?.role === 'admin' || isSuperAdmin,
  });

  const stats = data?.data;

  const cards = [
    ...(isSuperAdmin ? [{ label: 'Database capacity (paid plan)', value: stats?.databaseBytes === undefined ? 'Unavailable' : `${formatBytes(stats.databaseBytes)} / ${formatBytes(stats.databaseLimitBytes || 10_000_000_000)}` }] : []),
    { label: 'Total Users', value: stats?.totalUsers ?? 0 },
    { label: 'Total Emails', value: stats?.totalEmails ?? 0 },
    { label: 'Total Files', value: stats?.totalAttachments ?? 0 },
    // Declared by the shared AdminStats type and the plan, but the endpoint
    // never returned it, so it could not be shown until now.
    { label: 'Storage Used', value: formatBytes(stats?.storageUsedBytes ?? 0) },
    { label: 'Emails Today', value: stats?.emailsToday ?? 0 },
    { label: 'Emails This Week', value: stats?.emailsThisWeek ?? 0 },
  ];

  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>Admin Dashboard</h1>
          <p className="page-subtitle">Manage your email service</p>
        </div>
      </div>

      {isError && (
        <div className="login-error" style={{ marginBottom: 'var(--space-4)' }}>
          {(error as Error).message}
        </div>
      )}

      {isSuperAdmin && stats?.databaseBytes !== undefined && stats.databaseBytes >= (stats.databaseLimitBytes || 10_000_000_000) * 0.7 &&
        <p role="alert">Database storage is above 70% capacity. Plan additional database capacity before it fills. Archived email still uses database storage.</p>}
      <div className="stats-grid">
        {isLoading
          ? [...Array(cards.length)].map((_, i) => (
              <div key={i} className="stat-card">
                <div className="skeleton" style={{ width: '60%', height: 36, marginBottom: 8 }} />
                <div className="skeleton" style={{ width: '40%', height: 14 }} />
              </div>
            ))
          : cards.map((card) => (
              <div key={card.label} className="stat-card">
                <div className="stat-value">{card.value}</div>
                <div className="stat-label">{card.label}</div>
              </div>
            ))}
      </div>

      <h2 style={{ marginBottom: 'var(--space-4)' }}>Quick Actions</h2>
      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Link to="/admin/users" className="btn btn-secondary btn-action">
          <IconUsers size={18} /> Manage Users
        </Link>
        <Link to="/admin/reports" className="btn btn-secondary btn-action">
          <IconChart size={18} /> View Reports
        </Link>
        {isSuperAdmin && (        <Link to="/admin/retention" className="btn btn-secondary btn-action">
          <IconFolderCog size={18} /> Retention Policy
        </Link>)}
      </div>
    </div>
  );
}
