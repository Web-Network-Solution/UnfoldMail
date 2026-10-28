import { useRef, useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore, useToastStore } from '../stores';
import { authApi } from '../lib/api';
import { IconSettings, IconLogout } from './Icons';
import { subscribeInstallState, promptInstallApp, isRunningStandalone } from '../lib/pwa';

function getInitials(name: string): string {
  return name
    .split(/[@.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

export default function ProfileMenu() {
  const { user, setUser, stopImpersonation } = useAuthStore();
  const addToast = useToastStore((s) => s.addToast);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeInstallState((installable) => {
      setCanInstall(installable && !isRunningStandalone());
    });
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleLogout = async () => {
    try { await authApi.logout(); } catch { /* clear regardless */ }
    stopImpersonation();
    setUser(null);
    navigate('/login');
  };

  const handleInstallClick = async () => {
    setOpen(false);
    const installed = await promptInstallApp();
    if (installed) {
      addToast({ type: 'success', title: 'App Installed', body: 'UnfoldMail installed to your device!' });
    }
  };

  const copyEmail = () => {
    if (!user) return;
    navigator.clipboard.writeText(user.email).then(() =>
      addToast({ type: 'success', title: 'Copied', body: user.email })
    );
  };

  if (!user) return null;

  return (
    <div className="profile-menu-container" ref={menuRef}
      onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setOpen(false);}}
      onKeyDown={e=>{if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false);menuRef.current?.querySelector<HTMLButtonElement>('.profile-avatar-btn')?.focus();}}}>
      <button
        className="profile-avatar-btn"
        onClick={() => setOpen((v) => !v)}
        aria-label="Profile menu"
        aria-expanded={open}
        aria-controls={open ? 'profile-popover' : undefined}
        title={user.displayName}
      >
        {getInitials(user.displayName || user.email)}
      </button>

      {open && (
        <div id="profile-popover" className="profile-popover">
          <div className="profile-popover-header">
            <div className="profile-popover-avatar">
              {getInitials(user.displayName || user.email)}
            </div>
            <div className="profile-popover-info">
              <div className="profile-popover-name">{user.displayName}</div>
              <div className="profile-popover-email">
                <span>{user.email}</span>
                <button
                  className="profile-copy-btn"
                  onClick={copyEmail}
                  title="Copy email address"
                  aria-label="Copy email address"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <div className="profile-popover-divider" />

          {canInstall && (
            <button className="profile-popover-item" onClick={handleInstallClick}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              Install App
            </button>
          )}

          <Link
            to="/settings"
            className="profile-popover-item"
            onClick={() => setOpen(false)}
          >
            <IconSettings size={16} /> Settings
          </Link>

          {(user.role === 'admin' || user.role === 'super_admin') && (
            <Link
              to="/admin"
              className="profile-popover-item"
              onClick={() => setOpen(false)}
            >
              <IconSettings size={16} /> Admin Panel
            </Link>
          )}

          <div className="profile-popover-divider" />

          <button className="profile-popover-item logout" onClick={handleLogout}>
            <IconLogout size={16} /> Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
