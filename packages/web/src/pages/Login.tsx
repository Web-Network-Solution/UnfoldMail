import ProjectCredit from '../components/ProjectCredit';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores';
import { IconMail } from '../components/Icons';
import { authApi } from '../lib/api';
import { MIN_PASSWORD_LENGTH } from '@email-service/shared';

type Mode = 'login' | 'reset' | 'bootstrap';

export default function Login() {
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const setUser = useAuthStore((s) => s.setUser);
  const navigate = useNavigate();

  // A fresh deployment has no users at all, and creating one requires an admin
  // session â€” so offer first-run setup instead of an unusable login form.
  useEffect(() => {
    authApi
      .needsBootstrap()
      .then((res) => {
        if (res.data?.needsBootstrap) setMode('bootstrap');
      })
      .catch(() => {
        /* fall back to the normal login form */
      });
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const res = await authApi.login(email, password);
      const user = res.data?.user;
      if (!user) throw new Error('Login failed');

      // The API now blocks every other endpoint until the password changes, so
      // this is a real gate rather than a screen the user could skip.
      if (user.mustResetPassword) {
        setMode('reset');
        return;
      }

      setUser(user); // App's /login route then returns to the link that sent us here
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) return setError('Passwords do not match');
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (newPassword === password) {
      return setError('New password must differ from the temporary one');
    }

    setIsLoading(true);
    try {
      await authApi.resetPassword(password, newPassword);
      const res = await authApi.login(email, newPassword);
      setUser(res.data!.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) return setError('Passwords do not match');
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    setIsLoading(true);
    try {
      await authApi.bootstrap({ email, displayName, password: newPassword, bootstrapSecret });
      const res = await authApi.login(email, newPassword);
      setUser(res.data!.user);
      navigate('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg-gradient" />
      <div
        className="login-bg-gradient"
        style={{
          bottom: '-200px',
          left: '-200px',
          top: 'auto',
          right: 'auto',
          background: 'radial-gradient(circle, rgba(168,85,247,0.2) 0%, transparent 70%)',
        }}
      />

      <div className="login-card">
        <div className="sidebar-logo" style={{ marginBottom: 'var(--space-2)' }}>
          <div className="logo-icon">
            <IconMail size={22} />
          </div>
          <span>UnfoldMail</span>
        </div>

        <p>Grow your team. Keep email costs in your control.</p>
        <ProjectCredit />

        {error && <div className="login-error">{error}</div>}

        {mode === 'login' && (
          <>
            <h1>Welcome back</h1>
            <p>Sign in to access your inbox</p>

            <form className="login-form" onSubmit={handleLogin}>
              <div className="form-group">
                <label className="form-label" htmlFor="login-email">
                  Email
                </label>
                <input
                  id="login-email"
                  className="form-input"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="login-password">
                  Password
                </label>
                <input
                  id="login-password"
                  className="form-input"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <button
                className="btn btn-primary btn-block"
                type="submit"
                disabled={isLoading}
                style={{ marginTop: 'var(--space-2)' }}
              >
                {isLoading ? <span className="loading-spinner" /> : 'Sign In'}
              </button>
            </form>
          </>
        )}

        {mode === 'reset' && (
          <>
            <h1>Set New Password</h1>
            <p>Your admin requires you to change your password before continuing.</p>

            <form className="login-form" onSubmit={handleResetPassword}>
              <div className="form-group">
                <label className="form-label" htmlFor="new-password">
                  New Password
                </label>
                <input
                  id="new-password"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="confirm-password">
                  Confirm Password
                </label>
                <input
                  id="confirm-password"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Re-enter your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <button className="btn btn-primary btn-block" type="submit" disabled={isLoading}>
                {isLoading ? <span className="loading-spinner" /> : 'Set Password & Continue'}
              </button>
            </form>
          </>
        )}

        {mode === 'bootstrap' && (
          <>
            <h1>First-time setup</h1>
            <p>No accounts exist yet. Create the first administrator.</p>

            <form className="login-form" onSubmit={handleBootstrap}>
              <div className="form-group">
                <label className="form-label" htmlFor="setup-secret">Installation secret</label>
                <input id="setup-secret" className="form-input" type="password"
                  autoComplete="off" minLength={32} required value={bootstrapSecret}
                  onChange={(e) => setBootstrapSecret(e.target.value)} />
                <p>Enter the BOOTSTRAP_SECRET you supplied during deployment.</p>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="bootstrap-email">
                  Admin Email
                </label>
                <input
                  id="bootstrap-email"
                  className="form-input"
                  type="email"
                  autoComplete="username"
                  placeholder="admin@yourdomain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="bootstrap-name">
                  Display Name
                </label>
                <input
                  id="bootstrap-name"
                  className="form-input"
                  type="text"
                  placeholder="Jane Doe"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="bootstrap-password">
                  Password
                </label>
                <input
                  id="bootstrap-password"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  placeholder={`Minimum ${MIN_PASSWORD_LENGTH} characters`}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="bootstrap-confirm">
                  Confirm Password
                </label>
                <input
                  id="bootstrap-confirm"
                  className="form-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <button className="btn btn-primary btn-block" type="submit" disabled={isLoading}>
                {isLoading ? <span className="loading-spinner" /> : 'Create Admin Account'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
