import { AIEmailActions } from './AIQuickActions';
import EmailProductivityActions from './EmailProductivityActions';
import DeliveryStatus from './DeliveryStatus';
/**
 * Threaded conversation view.
 *
 * The threading endpoints existed from the start but had zero call sites, so
 * "inbox with threaded conversations" — the first feature in the requirements —
 * was unreachable in the UI.
 */
import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { attachmentApi, emailApi, folderApi } from '../lib/api';
import { useMailStore, useToastStore } from '../stores';
import type { Attachment, Email } from '@email-service/shared';
import EmailBody, { isOwnMail } from './EmailBody';
import { visibleAttachments } from '../lib/attachments';
import {
  IconMailEnvelope, IconReply, IconForward, IconPaperclip, IconFile,
} from './Icons';

interface ThreadViewProps {
  threadId: string;
  onClose: () => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return isNaN(date.getTime())
    ? ''
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

function initials(value: string): string {
  return value
    .split(/[@.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

export default function ThreadView({ threadId, onClose }: ThreadViewProps) {
  const { openCompose } = useMailStore();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data, isLoading, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['thread', threadId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => emailApi.getThread(threadId, pageParam),
    getNextPageParam: (page) => page.data?.nextCursor,
    enabled: !!threadId,
  });

  const addToast = useToastStore(s => s.addToast);
  const [loadingAction, setLoadingAction] = useState(false);
  const compose = async (email: Email, forward = false, replyAll = false) => {
    setLoadingAction(true);
    try {
      const detail = await emailApi.get(email.id);
      if (detail.data) openCompose(forward ? { forward: detail.data } : { replyTo: detail.data, replyAll });
    } catch (error) { addToast({ type: 'error', title: 'Could not open message', body: String(error) }); }
    finally { setLoadingAction(false); }
  };

  if (isLoading) {
    return (
      <div className="reading-pane">
        <div className="email-detail" style={{ padding: 'var(--space-6)' }}>
          <div className="skeleton" style={{ width: '70%', height: 28, marginBottom: 20 }} />
          <div className="skeleton" style={{ width: '100%', height: 12, marginBottom: 8 }} />
          <div className="skeleton" style={{ width: '90%', height: 12 }} />
        </div>
      </div>
    );
  }

  const messages = [...(data?.pages || [])].reverse().flatMap(page => page.data?.emails || []);

  if (messages.length === 0) {
    return (
      <div className="reading-pane">
        <div className="reading-pane-empty">
          <div className="empty-icon">
            <IconMailEnvelope size={48} color="var(--color-text-tertiary)" />
          </div>
          <p>{(error as Error)?.message || 'Conversation not found'}</p>
        </div>
      </div>
    );
  }

  const latest = messages[messages.length - 1];
  // Collapse everything but the newest message, the way a mail client does.
  const isOpen = (email: Email, index: number) =>
    expanded[email.id] ?? index === messages.length - 1;

  return (
    <div className="reading-pane">
      <div className="email-actions">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          ← Back
        </button>
        <button className="btn btn-ghost btn-sm" disabled={loadingAction} onClick={() => void compose(latest)}>
          <IconReply size={16} /> Reply
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={loadingAction} onClick={() => void compose(latest, false, true)}
        >
          <IconReply size={16} /> Reply all
        </button>
        <button className="btn btn-ghost btn-sm" disabled={loadingAction} onClick={() => void compose(latest, true)}>
          <IconForward size={16} /> Forward
        </button>
        <div style={{ flex: 1 }} />
        <span className="thread-message-count">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="email-detail">
        <h1 className="email-detail-subject">{messages[0].subject || '(no subject)'}</h1>

        <div className="thread-messages">
          {hasNextPage && <button className="btn btn-ghost btn-sm" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>Load older messages</button>}
          {isError && <p role="alert">{String(error)}</p>}
          {messages.map((email, index) => {
            const open = isOpen(email, index);
            return (
              <article key={email.id} className={`thread-message ${open ? 'open' : 'collapsed'}`}>
                <header
                  className="thread-message-header"
                  onClick={() => setExpanded((prev) => ({ ...prev, [email.id]: !open }))}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) =>
                    e.key === 'Enter' && setExpanded((prev) => ({ ...prev, [email.id]: !open }))
                  }
                >
                  <div className="email-avatar">{initials(email.senderName || email.sender)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="email-detail-sender-name">
                      {email.senderName || email.sender.split('@')[0]}
                      {!email.isRead && <span className="unread-dot" aria-label="Unread" />}
                    </div>
                    {open ? (
                      <div className="email-detail-sender-email">
                        To: {email.recipientsTo.map((r) => r.name || r.email).join(', ') || '(none)'}
                      </div>
                    ) : (
                      <div className="email-snippet">{email.snippet}</div>
                    )}
                  </div>
                  <div className="email-detail-date">{formatDate(email.receivedAt)}</div>
                </header>

                {open && <ThreadMessageBody email={email} />}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ThreadMessageBody({ email }: { email: Email }) {
  const client = useQueryClient();
  const detail = useQuery({ refetchInterval: query => ['queued', 'sending'].includes(query.state.data?.data?.deliveryStatus || '') ? 30_000 : false, queryKey: ['email', email.id], queryFn: () => emailApi.get(email.id) });
  // Same key as the sidebar and EmailView: served from cache, tells a draft or sent copy apart.
  const folders = useQuery({ queryKey: ['folders'], queryFn: () => folderApi.list() });
  useEffect(() => {
    if (!detail.data?.markedRead) return;
    for (const key of ['threads', 'emails', 'folders']) client.invalidateQueries({ queryKey: [key] });
  }, [detail.data, client]);
  if (detail.isPending) return <p>Loading message…</p>;
  if (detail.isError) return <p role="alert">{detail.error.message} <button onClick={() => void detail.refetch()}>Retry</button></p>;
  const message = detail.data?.data;
  if (!message) return null;
  return <>
    <DeliveryStatus email={message} />
    <EmailProductivityActions email={message} /><AIEmailActions emailId={message.id} />
    <div className="email-body"><EmailBody html={message.bodyHtml} text={message.bodyText} fallback={message.snippet} trusted={isOwnMail(message, folders.data?.data?.find(f => f.id === message.folderId)?.type)} /></div>
    {visibleAttachments(message).length > 0 && <div className="email-attachments">
      <div className="email-attachments-label"><IconPaperclip size={16} /> {visibleAttachments(message).length} attachments</div>
      {visibleAttachments(message).map((att: Attachment) => <a key={att.id} href={attachmentApi.download(att.id)} className="attachment-chip" download={att.filename} rel="noopener noreferrer"><IconFile size={14} /> {att.filename}</a>)}
    </div>}
  </>;
}
