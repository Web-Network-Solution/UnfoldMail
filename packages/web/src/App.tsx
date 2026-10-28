import AdminSetup from './pages/admin/Setup';
import AdminProtocolSettings from './pages/admin/ProtocolSettings';
import AdminAISettings from './pages/admin/AISettings';
import AIAssistant from './components/AIAssistant';
import AdminMailboxStorage from './pages/admin/MailboxStorage';
import AdminMeetingProviders from './pages/admin/MeetingProviders';
import CalendarResponse from './pages/CalendarResponse';
import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores';
import { authApi } from './lib/api';
import { useWebSocket } from './hooks/useWebSocket';
import Login from './pages/Login';
import MailLayout from './pages/MailLayout';
import Settings from './pages/Settings';
import AdminLayout from './pages/admin/AdminLayout';
import AdminDashboard from './pages/admin/Dashboard';
import AdminUsers from './pages/admin/Users';
import AdminRetention from './pages/admin/Retention';
import AdminReports from './pages/admin/Reports';
import AdminForwarding from './pages/admin/Forwarding';
import ToastContainer from './components/ToastContainer';
import ImpersonationBanner from './components/ImpersonationBanner';

/**
 * Route guard for the admin area.
 *
 * The API rejects non-admins with 403 regardless, but only the Dashboard used
 * to check the role client-side, so /admin/users and /admin/retention rendered
 * their full chrome for employees before failing.
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.role !== 'admin' && user?.role !== 'super_admin') return <Navigate to="/mail" replace />;
  return <>{children}</>;
}

type Return = { from?: unknown; mailUser?: string } | null;

/**
 * Sends a signed-out visit to sign-in, remembering the link and whose mail it
 * showed: useMailUrl ignores a message link written for another user.
 */
function ToLogin() {
  const { pathname, search, state } = useLocation();
  return <Navigate to="/login" replace state={{ from: pathname + search, mailUser: (state as Return)?.mailUser }} />;
}

/** After sign-in, back to the remembered link, only if it is a mail view on this origin. */
function FromLogin() {
  const state = useLocation().state as Return;
  let to = '/mail';
  try {
    const url = new URL(String(state?.from), window.location.origin);
    if (typeof state?.from === 'string' && url.origin === window.location.origin && /^\/mail(\/|$)/.test(url.pathname)) to = url.pathname + url.search;
  } catch { /* not a URL */ }
  return <Navigate to={to} replace state={{ mailUser: state?.mailUser }} />;
}

function App() {
  const { user, isLoading, setUser } = useAuthStore();

  useEffect(() => {
    // /auth/me stays reachable while must_reset_password is set, so a blocked
    // user arrives here as a normal user object carrying the flag — the
    // `blocked` check below is what gates them. (An earlier version also set a
    // separate store flag from a 403 branch this endpoint never returns, then
    // immediately clobbered it with setUser(null).)
    authApi
      .me()
      .then((res) => setUser(res.data || null))
      .catch(() => setUser(null));
  }, [setUser]);

  // A user carrying must_reset_password has a valid session — /auth/me returns
  // them — but the API 403s every other endpoint, including the WebSocket
  // upgrade. Treat them as not-yet-signed-in so the reset flow is the only
  // thing they can reach, and so the socket does not sit in a reconnect loop.
  const blocked = !user || user.mustResetPassword;

  useWebSocket(blocked ? null : user.id);

  if (isLoading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" style={{ width: 40, height: 40 }} />
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/calendar/respond" element={<CalendarResponse />} />
        {blocked ? (
          <>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<ToLogin />} />
          </>
        ) : (
          <>
            <Route path="/mail/*" element={<MailLayout />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <AdminLayout />
                </RequireAdmin>
              }
            >
              <Route index element={<AdminDashboard />} />
              <Route path="setup" element={<AdminSetup />} />
              <Route path="protocol" element={<AdminProtocolSettings />} />
              <Route path="ai" element={<AdminAISettings />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="reports" element={<AdminReports />} />
              <Route path="mailbox-storage" element={<AdminMailboxStorage />} />
              <Route path="meeting-providers" element={<AdminMeetingProviders />} />
              <Route path="retention" element={<AdminRetention />} />
              <Route path="forwarding" element={<AdminForwarding />} />
            </Route>
            <Route path="/login" element={<FromLogin />} />
            <Route path="*" element={<Navigate to="/mail" replace />} />
          </>
        )}
      </Routes>
      {user && !blocked && <AIAssistant key={user.id} />}
      <ToastContainer />
      <ImpersonationBanner />
    </>
  );
}

export default App;
