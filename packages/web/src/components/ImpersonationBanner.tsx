import { useNavigate } from 'react-router-dom';
import { useAuthStore, useToastStore } from '../stores';
import { ApiError, authApi } from '../lib/api';
import { useQueryClient } from '@tanstack/react-query';

export default function ImpersonationBanner() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, isImpersonating, impersonatingEmail, stopImpersonation, setUser } = useAuthStore();
  const addToast = useToastStore((s) => s.addToast);

  // Don't show if not impersonating, or if user session is gone (e.g. on login page)
  if (!isImpersonating || !user) return null;

  const handleSwitchBack = async () => {
    let switched = false;
    try {
      await authApi.stopImpersonate();
      switched = true;
      stopImpersonation();

      // Refresh user with original session (cookie was cleared, browser will send the original)
      const res = await authApi.me();
      if (res.success && res.data) {
        setUser(res.data);
      }

      // Invalidate all cached queries
      queryClient.invalidateQueries();

      addToast({ type: 'success', title: 'Switched back to your account' });
      navigate('/admin/users');
    } catch (err) {
      // If the original session also expired, force login
      addToast({ type: 'error', title: 'Session expired, please log in again' });
      // A network error or 5xx leaves both sessions valid, and a reload would
      // bring the impersonation back, so end them on the server. Not on a 4xx:
      // the cookie then belongs to a valid session, possibly another tab's.
      // Only when the switch itself failed: after a successful one the jar holds
      // the restored admin session, which a transient /auth/me error must not end.
      if (!switched && (!(err instanceof ApiError) || err.status >= 500)) authApi.logout().catch(() => {});
      stopImpersonation();
      // While a user is set, /login redirects straight back into the app.
      setUser(null);
      navigate('/login');
    }
  };

  return (
    <div className="impersonation-banner">
      <div className="impersonation-banner-content">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span>
          You are viewing as <strong>{impersonatingEmail}</strong>
        </span>
        <button className="impersonation-switch-back" onClick={handleSwitchBack}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Switch Back
        </button>
      </div>
    </div>
  );
}
