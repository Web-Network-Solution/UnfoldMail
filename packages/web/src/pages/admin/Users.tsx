import Select, { SelectOption } from '../../components/ui/Select';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi, authApi } from '../../lib/api';
import { useAuthStore, useToastStore } from '../../stores';
import { IconFile, IconWarning, IconClose } from '../../components/Icons';
import type { BulkImportResult, User } from '@email-service/shared';
import { MIN_PASSWORD_LENGTH } from '@email-service/shared';

const CSV_TEMPLATE = 'email,displayName,password,mustResetPassword\njane@yourdomain.com,Jane Doe,TempPass123,true\n';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

export default function AdminUsers() {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { startImpersonation, setUser } = useAuthStore();
  const [switchingUserId, setSwitchingUserId] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [importReport, setImportReport] = useState<BulkImportResult | null>(null);

  // Fetch the configured email domain from the backend (EMAIL_DOMAIN env var).
  // Creating is disabled until it is known; a placeholder domain created
  // accounts at an address nobody can receive mail on.
  const { data: statsData } = useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => adminApi.getStats(),
  });
  const emailDomain = statsData?.data?.emailDomain;

  const [form, setForm] = useState({
    username: '',
    displayName: '',
    password: '',
    role: 'employee',
    mustResetPassword: true,
  });

  // Credentials to show in the success modal
  const [createdCreds, setCreatedCreds] = useState<{
    email: string;
    password: string;
    loginUrl: string;
  } | null>(null);

  const [editForm, setEditForm] = useState({
    displayName: '',
    role: 'employee',
    mustResetPassword: false,
    newPassword: '',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => adminApi.listUsers(),
  });

  const users = data?.data || [];
  const adminCount = users.filter((u) => u.role === 'admin' || u.role === 'super_admin').length;
  const isSuperAdmin = currentUser?.role === 'super_admin';

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    // The dashboard totals are derived from the user list.
    queryClient.invalidateQueries({ queryKey: ['admin-stats'] });
  };

  const createMutation = useMutation({
    mutationFn: () => {
      const fullEmail = `${form.username}@${emailDomain}`;
      return adminApi.createUser({ ...form, email: fullEmail });
    },
    onSuccess: () => {
      const fullEmail = `${form.username}@${emailDomain}`;
      const loginUrl = window.location.origin + '/login';
      refresh();
      setShowCreate(false);
      setCreatedCreds({ email: fullEmail, password: form.password, loginUrl });
      setForm({ username: '', displayName: '', password: '', role: 'employee', mustResetPassword: true });
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Failed to create user', body: err.message }),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      adminApi.updateUser(editing!.id, {
        displayName: editForm.displayName,
        role: editForm.role,
        mustResetPassword: editForm.mustResetPassword,
        ...(editForm.newPassword ? { newPassword: editForm.newPassword } : {}),
      }),
    onSuccess: () => {
      refresh();
      setEditing(null);
      addToast({ type: 'success', title: 'User updated' });
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Failed to update user', body: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => adminApi.deleteUser(userId),
    onSuccess: () => {
      refresh();
      addToast({ type: 'success', title: 'User deleted' });
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Failed to delete user', body: err.message }),
  });

  const bulkImportMutation = useMutation({
    mutationFn: (file: File) => adminApi.bulkImport(file),
    onSuccess: (res) => {
      refresh();
      const report = res.data;
      if (report) {
        setImportReport(report);
        addToast({
          type: report.summary.skipped > 0 ? 'info' : 'success',
          title: 'Bulk import complete',
          body: `${report.summary.created} created, ${report.summary.skipped} skipped`,
        });
      }
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Bulk import failed', body: err.message }),
  });

  const openEdit = (user: User) => {
    setEditing(user);
    setEditForm({
      displayName: user.displayName,
      role: user.role,
      mustResetPassword: user.mustResetPassword,
      newPassword: '',
    });
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'employees-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'employee' | 'admin' | 'super_admin'>('all');

  const filteredUsers = users.filter((u) => {
    const matchesSearch =
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.displayName.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRole = roleFilter === 'all' || u.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  return (
    <div className="admin-page">
      <div className="admin-header user-management-header">
        <div>
          <h1>User Management</h1>
          <p className="page-subtitle">
            {users.length} user{users.length !== 1 ? 's' : ''} registered · {adminCount} admin
            {adminCount !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="user-management-actions">
          <Link to="/admin" className="btn btn-secondary btn-sm desktop-only">
            ← Back
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={downloadTemplate} title="Download CSV Template">
            Template
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => csvInputRef.current?.click()}
            disabled={bulkImportMutation.isPending}
          >
            {bulkImportMutation.isPending ? (
              <span className="loading-spinner" />
            ) : (
              <IconFile size={16} />
            )}{' '}
            CSV Import
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) bulkImportMutation.mutate(file);
              if (csvInputRef.current) csvInputRef.current.value = '';
            }}
            style={{ display: 'none' }}
          />
          <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)} disabled={!emailDomain} title={emailDomain ? undefined : 'Loading the mail domain (set EMAIL_DOMAIN if this persists)'}>
            + Add User
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="users-filter-bar">
        <div className="users-search-box">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            className="form-input search-users-input"
            placeholder="Search by email or name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-clear-search"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <IconClose size={14} />
            </button>
          )}
        </div>

        <div className="role-filter-pills">
          {(['all', 'employee', 'admin', 'super_admin'] as const).map((r) => (
            <button
              key={r}
              type="button"
              className={`pill-filter-btn ${roleFilter === r ? 'active' : ''}`}
              onClick={() => setRoleFilter(r)}
            >
              {r === 'all' ? 'All' : r === 'super_admin' ? 'Super Admin' : r === 'admin' ? 'Admin' : 'Employee'}
            </button>
          ))}
        </div>
      </div>

      {/* Per-row import outcome */}
      {importReport && (
        <div className="import-report">
          <div className="import-report-header">
            <strong>
              Import result — {importReport.summary.created} created,{' '}
              {importReport.summary.skipped} skipped
            </strong>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setImportReport(null)}
              aria-label="Dismiss"
            >
              <IconClose size={16} />
            </button>
          </div>
          <ul>
            {importReport.results.map((row) => (
              <li key={row.email} className={row.status === 'created' ? 'ok' : 'skipped'}>
                <code>{row.email}</code> — {row.status}
                {row.reason ? `: ${row.reason}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isLoading ? (
        <div style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
          <span className="loading-spinner" style={{ width: 32, height: 32 }} />
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="empty-state" style={{ padding: 'var(--space-8) 0', textAlign: 'center' }}>
          <p style={{ color: 'var(--color-text-tertiary)', margin: '0 auto' }}>
            {searchQuery || roleFilter !== 'all' ? 'No users matching filter criteria' : 'No users found'}
          </p>
        </div>
      ) : (
        <>
          {/* Mobile User Cards View (visible <= 768px) */}
          <div className="mobile-user-cards mobile-only">
            {filteredUsers.map((user) => {
              const isSelf = user.id === currentUser?.id;
              const isLastAdmin = (user.role === 'admin' || user.role === 'super_admin') && adminCount === 1;
              const canManage = isSuperAdmin || user.role === 'employee';

              return (
                <div key={user.id} className="user-mobile-card">
                  <div className="user-card-header">
                    <div className="user-card-avatar">
                      {user.displayName ? user.displayName.charAt(0).toUpperCase() : user.email.charAt(0).toUpperCase()}
                    </div>
                    <div className="user-card-info">
                      <div className="user-card-title-row">
                        <span className="user-card-name">{user.displayName || user.email.split('@')[0]}</span>
                        {isSelf && <span className="tag-self">you</span>}
                        <span className={`role-badge ${user.role}`}>{user.role}</span>
                      </div>
                      <div className="user-card-email">{user.email}</div>
                    </div>
                  </div>

                  <div className="user-card-stats-grid">
                    <div className="user-stat-item">
                      <span className="user-stat-label">Sent</span>
                      <span className="user-stat-val" style={{ color: '#10b981' }}>{user.totalSent ?? 0}</span>
                    </div>
                    <div className="user-stat-item">
                      <span className="user-stat-label">Received</span>
                      <span className="user-stat-val" style={{ color: '#3b82f6' }}>{user.totalReceived ?? 0}</span>
                    </div>
                    <div className="user-stat-item">
                      <span className="user-stat-label">Storage</span>
                      <span className="user-stat-val">{formatBytes(user.storageUsed ?? 0)}</span>
                    </div>
                    <div className="user-stat-item">
                      <span className="user-stat-label">Reset Req</span>
                      <span className="user-stat-val">
                        {user.mustResetPassword ? (
                          <span style={{ color: 'var(--color-warning)' }}>Yes</span>
                        ) : (
                          'No'
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="user-card-footer">
                    <div className="user-card-date">
                      Joined {new Date(user.createdAt).toLocaleDateString()}
                    </div>
                    <div className="user-card-actions">
                      {isSuperAdmin && !isSelf && (
                        <button
                          className="btn btn-secondary btn-xs btn-switch"
                          disabled={switchingUserId === user.id}
                          title={`View mailbox as ${user.email}`}
                          onClick={async () => {
                            setSwitchingUserId(user.id);
                            try {
                              const res = await authApi.impersonate(user.id);
                              if (res.success && res.data) {
                                startImpersonation(res.data.targetEmail, currentUser?.email || '');
                                const meRes = await authApi.me();
                                if (meRes.success && meRes.data) {
                                  setUser(meRes.data);
                                }
                                queryClient.invalidateQueries();
                                navigate('/mail');
                              }
                            } catch (err) {
                              addToast({ type: 'error', title: 'Failed to switch user', body: (err as Error).message });
                            } finally {
                              setSwitchingUserId(null);
                            }
                          }}
                        >
                          {switchingUserId === user.id ? <span className="loading-spinner" /> : (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                              <circle cx="9" cy="7" r="4" />
                              <polyline points="16 11 18 13 22 9" />
                            </svg>
                          )}
                          Switch
                        </button>
                      )}
                      <button
                        className="btn btn-secondary btn-xs"
                        onClick={() => openEdit(user)}
                        disabled={!canManage}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-danger btn-xs"
                        disabled={isSelf || isLastAdmin || !canManage || deleteMutation.isPending}
                        onClick={() => {
                          if (
                            confirm(
                              `Delete ${user.email}? This permanently removes their mailbox, attachments and stored files.`
                            )
                          ) {
                            deleteMutation.mutate(user.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop Responsive Table View (visible > 768px) */}
          <div className="table-responsive desktop-only">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Display Name</th>
                  <th>Role</th>
                  <th style={{ textAlign: 'center' }}>Sent</th>
                  <th style={{ textAlign: 'center' }}>Received</th>
                  <th style={{ textAlign: 'right' }}>Storage</th>
                  <th>Reset Required</th>
                  <th>Created</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user) => {
                  const isSelf = user.id === currentUser?.id;
                  const isLastAdmin = (user.role === 'admin' || user.role === 'super_admin') && adminCount === 1;
                  const canManage = isSuperAdmin || user.role === 'employee';
                  return (
                    <tr key={user.id}>
                      <td className="cell-strong">
                        {user.email}
                        {isSelf && <span className="tag-self">you</span>}
                      </td>
                      <td>{user.displayName}</td>
                      <td>
                        <span className={`role-badge ${user.role}`}>{user.role}</span>
                      </td>
                      <td style={{ textAlign: 'center', color: '#10b981', fontWeight: 600 }}>{user.totalSent ?? 0}</td>
                      <td style={{ textAlign: 'center', color: '#3b82f6', fontWeight: 600 }}>{user.totalReceived ?? 0}</td>
                      <td style={{ textAlign: 'right', fontSize: 'var(--font-size-sm)' }}>{formatBytes(user.storageUsed ?? 0)}</td>
                      <td>
                        {user.mustResetPassword ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-warning)' }}>
                            <IconWarning size={14} color="var(--color-warning)" /> Yes
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td style={{ fontSize: 'var(--font-size-sm)' }}>
                        {new Date(user.createdAt).toLocaleDateString()}
                      </td>
                      <td className="cell-actions" style={{ textAlign: 'right' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(user)} disabled={!canManage}>
                          Edit
                        </button>
                        <button
                          className="btn btn-ghost btn-sm btn-danger"
                          disabled={isSelf || isLastAdmin || !canManage || deleteMutation.isPending}
                          title={
                            isSelf
                              ? 'You cannot delete your own account'
                              : !canManage
                                ? 'Only super admins can delete admin users'
                                : isLastAdmin
                                  ? 'At least one admin must remain'
                                  : undefined
                          }
                          onClick={() => {
                            if (
                              confirm(
                                `Delete ${user.email}? This permanently removes their mailbox, attachments and stored files.`
                              )
                            ) {
                              deleteMutation.mutate(user.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                        {isSuperAdmin && !isSelf && (
                          <button
                            className="btn btn-ghost btn-sm btn-switch"
                            disabled={switchingUserId === user.id}
                            title={`View mailbox as ${user.email}`}
                            onClick={async () => {
                              setSwitchingUserId(user.id);
                              try {
                                const res = await authApi.impersonate(user.id);
                                if (res.success && res.data) {
                                  startImpersonation(res.data.targetEmail, currentUser?.email || '');
                                  const meRes = await authApi.me();
                                  if (meRes.success && meRes.data) {
                                    setUser(meRes.data);
                                  }
                                  queryClient.invalidateQueries();
                                  navigate('/mail');
                                }
                              } catch (err) {
                                addToast({ type: 'error', title: 'Failed to switch user', body: (err as Error).message });
                              } finally {
                                setSwitchingUserId(null);
                              }
                            }}
                          >
                            {switchingUserId === user.id ? <span className="loading-spinner" /> : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <polyline points="16 11 18 13 22 9" />
                              </svg>
                            )}
                            Switch
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ─── Create modal ─────────────────────────────────────── */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Create New User</h2>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setShowCreate(false)}
                aria-label="Close"
              >
                <IconClose size={18} />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate();
              }}
            >
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Username</label>
                  <div className="input-with-suffix">
                    <input
                      className="form-input"
                      type="text"
                      placeholder="username"
                      value={form.username}
                      onChange={(e) => setForm({ ...form, username: e.target.value.replace(/[@\s]/g, '').toLowerCase() })}
                      required
                      autoFocus
                    />
                    <span className="input-suffix">@{emailDomain}</span>
                  </div>
                  {form.username && (
                    <div className="form-hint">
                      Full email: <strong>{form.username}@{emailDomain}</strong>
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">Display Name</label>
                  <input
                    className="form-input"
                    type="text"
                    placeholder="John Doe"
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Temporary Password</label>
                  <input
                    className="form-input"
                    type="text"
                    placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <Select
                    aria-label="Role"
                    className="form-input"
                    value={form.role}
                    onValueChange={selectedValue => setForm({ ...form, role: selectedValue })}
                  >
                    <SelectOption value="employee">Employee</SelectOption>
                    {isSuperAdmin && <SelectOption value="admin">Admin</SelectOption>}
                    {isSuperAdmin && <SelectOption value="super_admin">Super Admin</SelectOption>}
                  </Select>
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.mustResetPassword}
                    onChange={(e) => setForm({ ...form, mustResetPassword: e.target.checked })}
                  />
                  Require password reset on first login
                </label>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit" disabled={createMutation.isPending || !emailDomain}>
                  {createMutation.isPending ? <span className="loading-spinner" /> : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Created credentials modal ────────────────────────── */}
      {createdCreds && (
        <div className="modal-overlay" onClick={() => setCreatedCreds(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>User Created Successfully</h2>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setCreatedCreds(null)}
                aria-label="Close"
              >
                <IconClose size={18} />
              </button>
            </div>
            <div className="modal-body">
              <p className="page-subtitle" style={{ marginBottom: 'var(--space-4)' }}>
                Share these credentials with the new user. This is the only time the password will be shown.
              </p>
              <div className="creds-card">
                <div className="creds-row">
                  <span className="creds-label">Login URL</span>
                  <span className="creds-value">{createdCreds.loginUrl}</span>
                </div>
                <div className="creds-row">
                  <span className="creds-label">Email</span>
                  <span className="creds-value">{createdCreds.email}</span>
                </div>
                <div className="creds-row">
                  <span className="creds-label">Password</span>
                  <span className="creds-value" style={{ fontFamily: 'monospace' }}>{createdCreds.password}</span>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setCreatedCreds(null)}
              >
                Close
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const text =
                    `Login URL: ${createdCreds.loginUrl}\n` +
                    `Email: ${createdCreds.email}\n` +
                    `Password: ${createdCreds.password}`;
                  navigator.clipboard.writeText(text).then(() =>
                    addToast({ type: 'success', title: 'Copied to clipboard' })
                  );
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                </svg>
                Copy All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit modal ───────────────────────────────────────── */}
      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Edit {editing.email}</h2>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => setEditing(null)}
                aria-label="Close"
              >
                <IconClose size={18} />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                updateMutation.mutate();
              }}
            >
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">Display Name</label>
                  <input
                    className="form-input"
                    type="text"
                    value={editForm.displayName}
                    onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                    required
                    autoFocus
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Role</label>
                  <Select
                    aria-label="Role"
                    className="form-input"
                    value={editForm.role}
                    disabled={editing.id === currentUser?.id}
                    onValueChange={selectedValue => setEditForm({ ...editForm, role: selectedValue })}
                  >
                    <SelectOption value="employee">Employee</SelectOption>
                    {isSuperAdmin && <SelectOption value="admin">Admin</SelectOption>}
                    {isSuperAdmin && <SelectOption value="super_admin">Super Admin</SelectOption>}
                  </Select>
                  {editing.id === currentUser?.id && (
                    <p className="field-hint">You cannot change your own role.</p>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">Reset Password (optional)</label>
                  <input
                    className="form-input"
                    type="text"
                    placeholder="Leave blank to keep the current password"
                    value={editForm.newPassword}
                    onChange={(e) => setEditForm({ ...editForm, newPassword: e.target.value })}
                  />
                  <p className="field-hint">Setting a password signs this user out everywhere.</p>
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editForm.mustResetPassword}
                    onChange={(e) =>
                      setEditForm({ ...editForm, mustResetPassword: e.target.checked })
                    }
                  />
                  Require password reset on next login
                </label>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button className="btn btn-primary" type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? <span className="loading-spinner" /> : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
