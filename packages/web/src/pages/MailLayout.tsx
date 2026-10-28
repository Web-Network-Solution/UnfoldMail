import ProjectCredit from '../components/ProjectCredit';
import { lazy, Suspense } from 'react';
const Calendar = lazy(() => import('./Calendar'));
const Contacts = lazy(() => import('./Contacts'));
import { useRealtimeStore } from '../stores';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuthStore, useMailStore, useToastStore } from '../stores';
import { authApi, folderApi } from '../lib/api';
import { useMailUrl } from '../hooks/useMailUrl';
import type { Folder } from '@email-service/shared';
import { SYSTEM_FOLDER_LABELS } from '@email-service/shared';
import EmailList from '../components/EmailList';
import EmailView from '../components/EmailView';
import ThreadView from '../components/ThreadView';
import ComposeModal from '../components/ComposeModal';
import SearchBar from '../components/SearchBar';
import ProfileMenu from '../components/ProfileMenu';
import ThemeToggle from '../components/ThemeToggle';
import {
  IconInbox, IconSend, IconDrafts, IconTrash,
  IconArchive, IconFolder, IconMail, IconCompose,
  IconSettings, IconLogout, IconClose, IconStar,
  IconMenu, IconCalendar, IconUsers,
} from '../components/Icons';

const FOLDER_ICONS: Record<string, React.ReactNode> = {
  inbox: <IconInbox size={18} />,
  sent: <IconSend size={18} />,
  drafts: <IconDrafts size={18} />,
  trash: <IconTrash size={18} />,
  archive: <IconArchive size={18} />,
  custom: <IconFolder size={18} />,
};

export default function MailLayout() {
  const { user, setUser, stopImpersonation } = useAuthStore();
  const {
    activeFolderId, activeFolder, selectedEmailId, selectedThreadId,
    setActiveFolder, setSelectedEmail, setSelectedThread,
    isComposeOpen, composeSession, openCompose, closeCompose,
    starredView, setStarredView,
  } = useMailStore();

  const navigate = useNavigate();
  const module = useLocation().pathname.split('/')[2];
  const productivity = module === 'calendar' || module === 'contacts';
  const connected = useRealtimeStore(s => s.connected);
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [newFolderName, setNewFolderName] = useState('');
  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // The installed app's Compose shortcut opens /mail?action=compose.
  useEffect(() => {
    if (searchParams.get('action') !== 'compose') return;
    openCompose();
    setSearchParams((params) => { params.delete('action'); return params; }, { replace: true });
  }, [searchParams, setSearchParams, openCompose]);

  const { data: foldersData } = useQuery({
    refetchInterval: connected ? 300_000 : 60_000,
    queryKey: ['folders'],
    queryFn: () => folderApi.list(),

  });

  const folders = foldersData?.data || [];
  const inboxFolder = folders.find((f: Folder) => f.type === 'inbox');
  const draftsFolder = folders.find((f: Folder) => f.type === 'drafts');

  // Folder, message and thread live in the URL: selecting pushes, so Back closes a message.
  const closeDone = useMailUrl(foldersData?.data, !productivity);

  const createFolder = useMutation({
    mutationFn: (name: string) => folderApi.create(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      setNewFolderName('');
      setIsAddingFolder(false);
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Could not create label', body: err.message }),
  });

  const deleteFolder = useMutation({
    mutationFn: (id: string) => folderApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['folders'] });
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      addToast({ type: 'success', title: 'Label deleted', body: 'Its mail moved to Inbox' });
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Could not delete label', body: err.message }),
  });

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Clear the client session regardless.
    }
    stopImpersonation();
    setUser(null);
    navigate('/login');
  };

  const handleFolderClick = (folder: Folder) => {
    if (productivity) navigate('/mail');
    setActiveFolder(folder);
    setSelectedEmail(null);
    setSelectedThread(null);
    setIsMobileSidebarOpen(false);
  };

  const handleStarredClick = () => {
    if (productivity) navigate('/mail');
    setStarredView(true);
    setSelectedEmail(null);
    setSelectedThread(null);
    setIsMobileSidebarOpen(false);
  };

  const systemFolders = folders.filter((f: Folder) => f.type !== 'custom');
  const customFolders = folders.filter((f: Folder) => f.type === 'custom');

  const renderFolder = (folder: Folder, deletable = false) => (
    <div
      key={folder.id}
      className={`folder-item ${folder.id === activeFolderId && !starredView && !productivity ? 'active' : ''}`}
      onClick={() => handleFolderClick(folder)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleFolderClick(folder)}
    >
      <span className="folder-icon">
        {folder.type === 'custom' ? FOLDER_ICONS.custom : FOLDER_ICONS[folder.type]}
      </span>
      <span className="folder-label">
        {folder.type === 'custom' ? folder.name : SYSTEM_FOLDER_LABELS[folder.type] || folder.name}
      </span>
      {(folder.unreadCount || 0) > 0 && <span className="badge">{folder.unreadCount}</span>}
      {deletable && (
        <button
          className="folder-delete"
          aria-label={`Delete label ${folder.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`Delete "${folder.name}"? Its emails move back to Inbox.`)) {
              deleteFolder.mutate(folder.id);
            }
          }}
        >
          <IconClose size={12} />
        </button>
      )}
    </div>
  );

  return (
    <div className="app-layout">
      {/* Mobile Backdrop */}
      {isMobileSidebarOpen && (
        <div
          className="mobile-sidebar-backdrop"
          onClick={() => setIsMobileSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      <aside className={`sidebar ${isMobileSidebarOpen ? 'mobile-open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="logo-icon">
              <IconMail size={22} />
            </div>
            <span>UnfoldMail</span>
            <button
              type="button"
              className="sidebar-close-btn mobile-only"
              onClick={() => setIsMobileSidebarOpen(false)}
              aria-label="Close menu"
            >
              <IconClose size={18} />
            </button>
          </div>
          <button
            className="compose-btn"
            onClick={() => {
              openCompose();
              setIsMobileSidebarOpen(false);
            }}
          >
            <IconCompose size={16} /> Compose
          </button>
        </div>

        <nav className="folder-nav">
          <div className="folder-section-label">Folders</div>
          {systemFolders.map((folder: Folder) => renderFolder(folder))}

          {/* Starred â€” virtual folder */}
          <div
            className={`folder-item ${starredView && !productivity ? 'active' : ''}`}
            onClick={handleStarredClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleStarredClick()}
          >
            <span className="folder-icon"><IconStar size={18} filled={starredView} /></span>
            <span className="folder-label">Starred</span>
          </div>

          <div className="folder-section-label" style={{ marginTop: 'var(--space-4)' }}>
            Labels
            <button
              className="folder-add"
              onClick={() => setIsAddingFolder((v) => !v)}
              aria-label="Create label"
            >
              +
            </button>
          </div>

          {isAddingFolder && (
            <form
              className="folder-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (newFolderName.trim()) createFolder.mutate(newFolderName.trim());
              }}
            >
              <input
                className="form-input"
                placeholder="Label name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                maxLength={60}
                autoFocus
              />
            </form>
          )}

          {customFolders.map((folder: Folder) => renderFolder(folder, true))}
        </nav>

        <div className="sidebar-footer">
          <ProjectCredit />
          <nav aria-label="Workspace">
          <div className="folder-section-label">Workspace</div>
          <Link to="/mail/calendar" className={`folder-item ${module === 'calendar' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconCalendar size={18}/><span>Calendar</span></Link>
          <Link to="/mail/contacts" className={`folder-item ${module === 'contacts' ? 'active' : ''}`} onClick={() => setIsMobileSidebarOpen(false)}><IconUsers size={18}/><span>Contacts</span></Link>
          </nav>
          <Link
            to="/settings"
            className="btn btn-ghost btn-sm sidebar-link"
            onClick={() => setIsMobileSidebarOpen(false)}
          >
            <IconSettings size={16} /> Settings
          </Link>
          {(user?.role === 'admin' || user?.role === 'super_admin') && (
            <Link
              to="/admin"
              className="btn btn-ghost btn-sm sidebar-link"
              onClick={() => setIsMobileSidebarOpen(false)}
            >
              <IconSettings size={16} /> Admin Panel
            </Link>
          )}
          <button
            className="btn btn-ghost btn-sm sidebar-link"
            onClick={() => {
              setIsMobileSidebarOpen(false);
              handleLogout();
            }}
          >
            <IconLogout size={16} /> Sign Out
          </button>
          <div className="sidebar-user">{user?.email}</div>
        </div>
      </aside>

      <main className="main-content">
        <div className="top-bar">
          <button
            type="button"
            className="btn-hamburger mobile-only"
            onClick={() => setIsMobileSidebarOpen((v) => !v)}
            aria-label="Toggle navigation menu"
          >
            <IconMenu size={22} />
          </button>
          {productivity ? <div className="workspace-breadcrumb"><Link to="/mail">Mail</Link><span>/</span><strong>{module === 'calendar' ? 'Calendar' : 'Contacts'}</strong></div> : <SearchBar />}
          <div className="top-bar-actions">
            <ThemeToggle />
            <ProfileMenu />
          </div>
        </div>

        {module === 'calendar' ? <Suspense fallback={<div className="productivity-empty">Loading calendarâ€¦</div>}><Calendar /></Suspense> : module === 'contacts' ? <Suspense fallback={<div className="productivity-empty">Loading contactsâ€¦</div>}><Contacts /></Suspense> : <div className="mail-panes">
          <div className={`list-pane ${selectedEmailId || selectedThreadId ? 'narrow' : ''}`}>
            <EmailList
              folderId={activeFolderId}
              folderName={
                starredView
                  ? 'Starred'
                  : activeFolder
                    ? activeFolder.type === 'custom'
                      ? activeFolder.name
                      : SYSTEM_FOLDER_LABELS[activeFolder.type] || activeFolder.name
                    : 'Inbox'
              }
              folderType={starredView ? 'starred' : (activeFolder?.type || 'inbox')}
              starred={starredView}
              selectedEmailId={selectedEmailId}
              selectedThreadId={selectedThreadId}
              onSelectEmail={setSelectedEmail}
              onSelectThread={setSelectedThread}
            />
          </div>

          {selectedEmailId && (
            <div className="detail-pane">
              <EmailView emailId={selectedEmailId} onClose={() => setSelectedEmail(null)} onDone={closeDone} />
            </div>
          )}

          {selectedThreadId && (
            <div className="detail-pane">
              <ThreadView threadId={selectedThreadId} onClose={() => setSelectedThread(null)} />
            </div>
          )}
        </div>}
      </main>

      {/* Floating Action Button for Mobile Compose */}
      <button
        type="button"
        className="mobile-compose-fab mobile-only"
        onClick={() => openCompose()}
        aria-label="Compose email"
        title="Compose"
      >
        <IconCompose size={24} />
      </button>

      {/* Mobile Bottom Sticky Navigation Menu (Inbox, Sent, Drafts, Trash, Settings) */}
      <nav className="bottom-nav mobile-only" aria-label="Bottom Navigation">
        <button
          type="button"
          className={`bottom-nav-item ${activeFolder?.type === 'inbox' && !starredView && !productivity ? 'active' : ''}`}
          onClick={() => {
            if (inboxFolder) handleFolderClick(inboxFolder);
          }}
        >
          <span className="bottom-nav-icon">
            <IconInbox size={20} />
            {(inboxFolder?.unreadCount || 0) > 0 && (
              <span className="bottom-nav-badge">{inboxFolder?.unreadCount}</span>
            )}
          </span>
          <span className="bottom-nav-label">Inbox</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-item ${activeFolder?.type === 'sent' && !starredView && !productivity ? 'active' : ''}`}
          onClick={() => {
            const sent = folders.find((f: Folder) => f.type === 'sent');
            if (sent) handleFolderClick(sent);
          }}
        >
          <span className="bottom-nav-icon">
            <IconSend size={20} />
          </span>
          <span className="bottom-nav-label">Sent</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-item ${activeFolder?.type === 'drafts' && !starredView && !productivity ? 'active' : ''}`}
          onClick={() => {
            const drafts = folders.find((f: Folder) => f.type === 'drafts');
            if (drafts) handleFolderClick(drafts);
          }}
        >
          <span className="bottom-nav-icon">
            <IconDrafts size={20} />
            {(draftsFolder?.unreadCount || 0) > 0 && (
              <span className="bottom-nav-badge">{draftsFolder?.unreadCount}</span>
            )}
          </span>
          <span className="bottom-nav-label">Drafts</span>
        </button>

        <button
          type="button"
          className={`bottom-nav-item ${activeFolder?.type === 'trash' && !starredView && !productivity ? 'active' : ''}`}
          onClick={() => {
            const trash = folders.find((f: Folder) => f.type === 'trash');
            if (trash) handleFolderClick(trash);
          }}
        >
          <span className="bottom-nav-icon">
            <IconTrash size={20} />
          </span>
          <span className="bottom-nav-label">Trash</span>
        </button>

        <Link
          to="/settings"
          className="bottom-nav-item"
        >
          <span className="bottom-nav-icon">
            <IconSettings size={20} />
          </span>
          <span className="bottom-nav-label">Settings</span>
        </Link>
      </nav>

      {/* Compose modal */}
      {isComposeOpen && <ComposeModal key={composeSession} onClose={closeCompose} />}
    </div>
  );
}
