import { deliveryLabel } from './DeliveryStatus';
import { useRealtimeStore } from '../stores';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { emailApi } from '../lib/api';
import type { Email, Thread } from '@email-service/shared';
import { useMailStore } from '../stores';
import { IconMailbox, IconPaperclip, IconStar } from './Icons';

interface EmailListProps {
  folderId: string | null;
  folderName: string;
  /** The type of the active folder — used to decide sender vs recipient display. */
  folderType?: string;
  /** True when the virtual "Starred" view is active. */
  starred?: boolean;
  selectedEmailId: string | null;
  selectedThreadId: string | null;
  onSelectEmail: (id: string) => void;
  onSelectThread: (id: string) => void;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const diffDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function getInitials(name: string): string {
  return name
    .split(/[@.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

/**
 * For sent/drafts: show the first recipient instead of the sender.
 */
function displayName(email: Email, showRecipient: boolean): string {
  if (showRecipient) {
    const first = email.recipientsTo?.[0];
    if (first) return first.name || first.email.split('@')[0];
    return '(no recipients)';
  }
  return email.senderName || email.sender.split('@')[0];
}

function displayKey(email: Email, showRecipient: boolean): string {
  if (showRecipient) {
    const first = email.recipientsTo?.[0];
    return first?.email || email.sender;
  }
  return email.senderName || email.sender;
}

export default function EmailList({
  folderId,
  folderName,
  folderType,
  starred,
  selectedEmailId,
  selectedThreadId,
  onSelectEmail,
  onSelectThread,
}: EmailListProps) {
  const { view, setView, page, setPage } = useMailStore();
  const connected = useRealtimeStore(s => s.connected);

  /** Show recipient names instead of sender in sent / drafts folders. */
  const showRecipient = folderType === 'sent' || folderType === 'drafts';

  const messagesQuery = useQuery({
    refetchInterval: connected ? 300_000 : 60_000,
    queryKey: starred ? ['emails', '__starred__', page] : ['emails', folderId, page],
    queryFn: () =>
      starred
        ? emailApi.list({ page, starred: true })
        : emailApi.list({ folderId: folderId || undefined, page }),
    enabled: starred ? true : (!!folderId && view === 'messages'),

    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (starred ? '__starred__' : folderId) ? previous : undefined,
  });

  const threadsQuery = useQuery({
    refetchInterval: connected ? 300_000 : 60_000,
    queryKey: ['threads', folderId, page],
    queryFn: () => emailApi.listThreads({ folderId: folderId || undefined, page }),
    enabled: !!folderId && view === 'threads' && !starred,

    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === folderId ? previous : undefined,
  });

  // Starred is a message list: in Threads view it used the disabled threads query and always showed 'No emails'.
  const threaded = view === 'threads' && !starred;
  const active = threaded ? threadsQuery : messagesQuery;
  const items = active.data?.data || [];
  const pagination = active.data?.pagination;

  // Deleting the last item on the final page (or a shrinking folder) used to
  // strand the user on an empty page with no controls to get back.
  useEffect(() => {
    if (pagination && pagination.totalPages > 0 && page > pagination.totalPages) {
      setPage(pagination.totalPages);
    }
  }, [pagination, page, setPage]);

  const header = (
    <div className="email-list-header">
      <h2>{folderName}</h2>
      <div className="email-list-header-actions">
        <div className="view-toggle" role="group" aria-label="View mode">
          <button
            className={view === 'messages' ? 'active' : ''}
            onClick={() => setView('messages')}
          >
            Messages
          </button>
          <button className={view === 'threads' ? 'active' : ''} onClick={() => setView('threads')}>
            Threads
          </button>
        </div>
        {pagination && (
          <span className="email-list-count">
            {pagination.total} {threaded ? 'conversations' : 'emails'}
          </span>
        )}
      </div>
    </div>
  );

  // Include the not-yet-resolved folder: without it, 'No emails' flashed
  // before the folder list had even loaded.
  if (!folderId || active.isLoading) {
    return (
      <div className="email-list-container">
        {header}
        {[...Array(8)].map((_, i) => (
          <div key={i} className="email-item" style={{ gap: 'var(--space-3)' }}>
            <div className="skeleton" style={{ width: 36, height: 36, borderRadius: '50%' }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton" style={{ width: '60%', height: 14, marginBottom: 6 }} />
              <div className="skeleton" style={{ width: '80%', height: 12, marginBottom: 4 }} />
              <div className="skeleton" style={{ width: '40%', height: 10 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (active.isError) {
    return (
      <div className="email-list-container">
        {header}
        <div className="empty-state">
          <h3>Could not load mail</h3>
          <p>{(active.error as Error)?.message}</p>
          <button className="btn btn-secondary" onClick={() => active.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="email-list-container">
        {header}
        <div className="empty-state">
          <div className="empty-icon">
            <IconMailbox size={48} color="var(--color-text-tertiary)" />
          </div>
          <h3>No emails</h3>
          <p>This folder is empty</p>
        </div>
      </div>
    );
  }

  return (
    <div className="email-list-container">
      {header}

      <div className="email-list-scroll">
        {threaded
          ? (items as Thread[]).map((thread) => (
              <div
                key={thread.id}
                className={`email-item ${thread.unreadCount > 0 ? 'unread' : ''} ${
                  thread.id === selectedThreadId ? 'active' : ''
                }`}
                onClick={() => onSelectThread(thread.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && onSelectThread(thread.id)}
              >
                <div className="email-avatar">{getInitials(thread.participants[0] || '?')}</div>
                <div className="email-content">
                  <div className="email-header-row">
                    <span className="email-sender">
                      {thread.participants.map((p) => p.split('@')[0]).join(', ')}
                      {thread.messageCount > 1 && (
                        <span className="thread-count"> ({thread.messageCount})</span>
                      )}
                    </span>
                    <span className="email-time">{formatTime(thread.lastMessageAt)}</span>
                  </div>
                  <div className="email-subject">{thread.deliveryStatus && thread.deliveryStatus !== 'sent' && <strong>{deliveryLabel(thread.deliveryStatus)} · </strong>}{thread.subject || '(no subject)'}</div>
                  <div className="email-snippet">{thread.snippet}</div>
                  {thread.hasAttachments && (
                    <div className="email-meta">
                      <span className="attachment-indicator">
                        <IconPaperclip size={14} />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))
          : (items as Email[]).map((email) => (
              <div
                key={email.id}
                className={`email-item ${!email.isRead ? 'unread' : ''} ${
                  email.id === selectedEmailId ? 'active' : ''
                }`}
                onClick={() => onSelectEmail(email.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && onSelectEmail(email.id)}
              >
                <div className="email-avatar">{getInitials(displayKey(email, showRecipient))}</div>
                <div className="email-content">
                  <div className="email-header-row">
                    <span className="email-sender">
                      {showRecipient && <span className="sent-to-prefix">To </span>}
                      {displayName(email, showRecipient)}
                    </span>
                    <span className="email-time">{formatTime(email.receivedAt)}</span>
                  </div>
                  <div className="email-subject">{email.deliveryStatus && email.deliveryStatus !== 'sent' && <strong>{deliveryLabel(email.deliveryStatus)} · </strong>}{email.subject || '(no subject)'}</div>
                  <div className="email-snippet">{email.snippet}</div>
                  {(email.hasAttachments || email.isStarred) && (
                    <div className="email-meta">
                      {email.isStarred && (
                        <span className="star-indicator">
                          <IconStar size={14} filled />
                        </span>
                      )}
                      {email.hasAttachments && (
                        <span className="attachment-indicator">
                          <IconPaperclip size={14} />
                          {email.attachmentCount ? ` ${email.attachmentCount}` : ''}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
      </div>

      {/* Without these, only the first 25 items in a folder were ever reachable. */}
      {pagination && pagination.totalPages > 1 && (
        <div className="pagination">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1 || active.isFetching}
          >
            ← Previous
          </button>
          <span className="pagination-info">
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
            disabled={page >= pagination.totalPages || active.isFetching}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
