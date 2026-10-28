import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router-dom';
import { adminApi } from '../../lib/api';
import { useAuthStore, useToastStore } from '../../stores';
import { IconArchive, IconTrash, IconLightbulb } from '../../components/Icons';

export default function AdminRetention() {
  const allowed = useAuthStore(s => s.user?.role === 'super_admin');
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);

  const [archiveDays, setArchiveDays] = useState(365);
  const [trashDays, setTrashDays] = useState(30);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-retention'],
    enabled: allowed,
    queryFn: () => adminApi.getRetention(),
  });

  useEffect(() => {
    if (data?.data) {
      setArchiveDays(data.data.archiveAfterDays);
      setTrashDays(data.data.deleteTrashAfterDays);
    }
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: () =>
      adminApi.updateRetention({
        archiveAfterDays: archiveDays,
        deleteTrashAfterDays: trashDays,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-retention'] });
      addToast({ type: 'success', title: 'Retention policy updated' });
    },
    onError: (err: any) => {
      addToast({ type: 'error', title: 'Failed to update', body: err.message });
    },
  });

  if (!allowed) return <Navigate to="/admin" replace />;
  return (
    <div className="admin-page">
      <div className="admin-header">
        <div>
          <h1>Retention Policy</h1>
          <p style={{ color: 'var(--color-text-tertiary)', marginTop: 'var(--space-1)' }}>
            Configure automatic email archival and deletion
          </p>
        </div>
        <Link to="/admin" className="btn btn-secondary">← Back</Link>
      </div>

      {isLoading ? (
        <div style={{ padding: 'var(--space-8)', textAlign: 'center' }}>
          <span className="loading-spinner" style={{ width: 32, height: 32 }} />
        </div>
      ) : (
        <div style={{
          maxWidth: 600,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-6)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {/* Archive setting */}
            <div className="form-group">
              <label className="form-label" style={{ fontSize: 'var(--font-size-md)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                <IconArchive size={18} /> Auto-Archive
              </label>
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Emails older than this will be automatically marked as archived.
                Archived emails remain searchable and viewable from R2 storage.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <input
                  className="form-input"
                  type="number"
                  min={1}
                  value={archiveDays}
                  onChange={(e) => setArchiveDays(parseInt(e.target.value) || 1)}
                  style={{ width: 120 }}
                />
                <span style={{ color: 'var(--color-text-secondary)' }}>days</span>
              </div>
            </div>

            {/* Trash setting */}
            <div className="form-group">
              <label className="form-label" style={{ fontSize: 'var(--font-size-md)', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                <IconTrash size={18} /> Auto-Delete Trash
              </label>
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-tertiary)', marginBottom: 'var(--space-2)' }}>
                Emails in trash older than this will be permanently deleted,
                including their attachments from R2 storage. This action is irreversible.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <input
                  className="form-input"
                  type="number"
                  min={1}
                  value={trashDays}
                  onChange={(e) => setTrashDays(parseInt(e.target.value) || 1)}
                  style={{ width: 120 }}
                />
                <span style={{ color: 'var(--color-text-secondary)' }}>days</span>
              </div>
            </div>

            {/* Info box */}
            <div style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--color-info)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-secondary)',
            }}>
              <IconLightbulb size={16} /> The retention job runs every 15 minutes. Changes take effect on the next run.
            </div>

            <button
              className="btn btn-primary"
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending}
              style={{ alignSelf: 'flex-start' }}
            >
              {updateMutation.isPending ? <span className="loading-spinner" /> : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
