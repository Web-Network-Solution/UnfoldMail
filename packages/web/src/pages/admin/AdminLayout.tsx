import ProjectCredit from '../../components/ProjectCredit';
import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  IconMail, IconUsers, IconFolderCog, IconChart,
  IconDashboard, IconLogout, IconMenu, IconClose,
} from '../../components/Icons';
import ProfileMenu from '../../components/ProfileMenu';
import ThemeToggle from '../../components/ThemeToggle';
import { useAuthStore } from '../../stores';
import { authApi } from '../../lib/api';

const NAV_ITEMS = [
  { to: '/admin', label: 'Dashboard', icon: IconDashboard, exact: true },
  { to: '/admin/users', label: 'Users', icon: IconUsers, exact: false },
  { to: '/admin/reports', label: 'Reports', icon: IconChart, exact: false },
  { to: '/admin/retention', label: 'Retention', icon: IconFolderCog, exact: false },
];

export default function AdminLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { setUser, stopImpersonation } = useAuthStore();
  const role = useAuthStore(s => s.user?.role);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Clear client session regardless
    }
    stopImpersonation();
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="admin-layout">
      {/* Mobile Backdrop */}
      {isMobileSidebarOpen && (
        <div
          className="mobile-sidebar-backdrop"
          onClick={() => setIsMobileSidebarOpen(false)}
          aria-label="Close menu"
        />
      )}

      <aside className={`admin-sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
        <div className="admin-sidebar-header">
          <div className="logo">
            <div className="logo-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <span>Admin</span>
            <button
              type="button"
              className="sidebar-close-btn mobile-only"
              onClick={() => setIsMobileSidebarOpen(false)}
              aria-label="Close menu"
            >
              <IconClose size={18} />
            </button>
          </div>
        </div>

        <nav className="admin-nav">
          {role === 'super_admin' && <Link to="/admin/protocol" className={`admin-nav-item ${pathname === '/admin/protocol' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconMail size={18}/><span>Mail app access</span></Link>}
          {role === 'super_admin' && <Link to="/admin/ai" className={`admin-nav-item ${pathname === '/admin/ai' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconFolderCog size={18}/><span>AI assistant</span></Link>}
          {role === 'super_admin' && <Link to="/admin/mailbox-storage" className={`admin-nav-item ${pathname === '/admin/mailbox-storage' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconFolderCog size={18}/><span>Mailbox storage</span></Link>}
          {role === 'super_admin' && <Link to="/admin/meeting-providers" className={`admin-nav-item ${pathname === '/admin/meeting-providers' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconFolderCog size={18}/><span>Meeting providers</span></Link>}
          {role === 'super_admin' && <Link to="/admin/forwarding" className={`admin-nav-item ${pathname === '/admin/forwarding' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconMail size={18} /><span>Forwarding</span></Link>}
          {NAV_ITEMS.filter(item => role === 'super_admin' || item.to !== '/admin/retention').map((item) => {
            const active = item.exact
              ? pathname === item.to
              : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`admin-nav-item ${active ? 'active' : ''}`}
                onClick={() => setIsMobileSidebarOpen(false)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="admin-sidebar-footer">
          <ProjectCredit />
          <Link
            to="/mail"
            className="admin-nav-item back-to-mail"
            onClick={() => setIsMobileSidebarOpen(false)}
          >
            <IconMail size={18} />
            <span>Back to Mail</span>
          </Link>
          <button
            type="button"
            className="admin-nav-item"
            style={{ color: 'var(--color-danger, #ef4444)', marginTop: 'var(--space-2)' }}
            onClick={() => {
              setIsMobileSidebarOpen(false);
              handleLogout();
            }}
          >
            <IconLogout size={18} color="var(--color-danger, #ef4444)" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <div className="admin-top-bar">
          <button
            type="button"
            className="btn-hamburger mobile-only"
            onClick={() => setIsMobileSidebarOpen((v) => !v)}
            aria-label="Toggle admin navigation menu"
          >
            <IconMenu size={22} />
          </button>
          <div style={{ flex: 1 }} />
          <ThemeToggle />
          <ProfileMenu />
        </div>
        <div className="admin-content">
          <Outlet />
        </div>
      </main>

      {/* Mobile Bottom Sticky Navigation Menu for Admin (Dashboard, Users, Reports, Retention, Back To mail, logout) */}
      <nav className="bottom-nav admin-bottom-nav mobile-only" aria-label="Admin Bottom Navigation">
        <Link
          to="/admin"
          className={`bottom-nav-item ${pathname === '/admin' ? 'active' : ''}`}
        >
          <span className="bottom-nav-icon">
            <IconDashboard size={19} />
          </span>
          <span className="bottom-nav-label">Dashboard</span>
        </Link>

        <Link
          to="/admin/users"
          className={`bottom-nav-item ${pathname.startsWith('/admin/users') ? 'active' : ''}`}
        >
          <span className="bottom-nav-icon">
            <IconUsers size={19} />
          </span>
          <span className="bottom-nav-label">Users</span>
        </Link>

        <Link
          to="/admin/reports"
          className={`bottom-nav-item ${pathname.startsWith('/admin/reports') ? 'active' : ''}`}
        >
          <span className="bottom-nav-icon">
            <IconChart size={19} />
          </span>
          <span className="bottom-nav-label">Reports</span>
        </Link>

        {role === 'super_admin' && (        <Link
          to="/admin/retention"
          className={`bottom-nav-item ${pathname.startsWith('/admin/retention') ? 'active' : ''}`}
        >
          <span className="bottom-nav-icon">
            <IconFolderCog size={19} />
          </span>
          <span className="bottom-nav-label">Retention</span>
        </Link>)}

        <Link
          to="/mail"
          className="bottom-nav-item"
        >
          <span className="bottom-nav-icon">
            <IconMail size={19} />
          </span>
          <span className="bottom-nav-label">Mail</span>
        </Link>

        <button
          type="button"
          className="bottom-nav-item"
          onClick={handleLogout}
        >
          <span className="bottom-nav-icon">
            <IconLogout size={19} color="var(--color-danger, #ef4444)" />
          </span>
          <span className="bottom-nav-label" style={{ color: 'var(--color-danger, #ef4444)' }}>
            Logout
          </span>
        </button>
      </nav>
    </div>
  );
}
