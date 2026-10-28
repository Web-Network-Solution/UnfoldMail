import Select, { SelectOption } from './ui/Select';
import { AIEmailActions } from './AIQuickActions';
import EmailProductivityActions from './EmailProductivityActions';
import DeliveryStatus from './DeliveryStatus';
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { attachmentApi, emailApi, folderApi } from '../lib/api';
import { useMailStore, useToastStore } from '../stores';
import type { Attachment, Folder } from '@email-service/shared';
import EmailBody, { isOwnMail } from './EmailBody';
import { visibleAttachments } from '../lib/attachments';
import {
  IconMailEnvelope, IconReply, IconForward, IconStar,
  IconTrash, IconPaperclip, IconFile, IconArchive, IconFolder,
  IconDownload,
} from './Icons';

interface EmailViewProps {
  emailId: string;
  onClose: () => void;
  /** Closes after Delete, Move or Mark unread; defaults to onClose. */
  onDone?: () => void;
}

function formatFullDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initials(value: string): string {
  return value
    .split(/[@.\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
}

/** Deterministic color from a string. */
function avatarColor(value: string): string {
  const colors = [
    '#1a73e8', '#e8453c', '#f5a623', '#0b8043', '#8e24aa',
    '#d81b60', '#00897b', '#6d4c41', '#546e7a', '#e65100',
  ];
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = value.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

/** Return the file extension icon color. */
function attachmentColor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    pdf: '#ea4335', doc: '#4285f4', docx: '#4285f4', xls: '#34a853',
    xlsx: '#34a853', ppt: '#fbbc04', pptx: '#fbbc04', zip: '#546e7a',
    rar: '#546e7a', png: '#e8453c', jpg: '#e8453c', jpeg: '#e8453c',
    gif: '#e8453c', svg: '#e8453c', mp4: '#8e24aa', mov: '#8e24aa',
  };
  return map[ext] || 'var(--color-accent)';
}

export default function EmailView({ emailId, onClose, onDone = onClose }: EmailViewProps) {
  const queryClient = useQueryClient();
  const { openCompose } = useMailStore();
  const addToast = useToastStore((s) => s.addToast);

  const { data, isLoading } = useQuery({
    refetchInterval: query => ['queued', 'sending'].includes(query.state.data?.data?.deliveryStatus || '') ? 30_000 : false,
    queryKey: ['email', emailId],
    queryFn: () => emailApi.get(emailId),
    enabled: !!emailId,
  });

  const { data: foldersData } = useQuery({
    queryKey: ['folders'],
    queryFn: () => folderApi.list(),
  });

  useEffect(() => {
    if (!data?.markedRead) return;
    queryClient.invalidateQueries({ queryKey: ['emails'] });
    queryClient.invalidateQueries({ queryKey: ['threads'] });
    queryClient.invalidateQueries({ queryKey: ['folders'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.data?.id, data?.markedRead]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['emails'] });
    queryClient.invalidateQueries({ queryKey: ['threads'] });
    queryClient.invalidateQueries({ queryKey: ['thread'] });
    queryClient.invalidateQueries({ queryKey: ['folders'] });
  };

  // Delete forever is chosen from the cached folder, so a moved message must not
  // reopen from a still-fresh cache entry that says where it used to be.
  const forget = () => queryClient.removeQueries({ queryKey: ['email', emailId] });

  const deleteMutation = useMutation({
    mutationFn: (permanent: boolean) => emailApi.delete(emailId, permanent),
    onSuccess: () => { forget(); invalidate(); onDone(); },
    // The server refuses a permanent delete outside Trash (409): show that, and
    // refetch so the button matches where the message really is.
    onError: (err: Error) => { queryClient.invalidateQueries({ queryKey: ['email', emailId] }); addToast({ type: 'error', title: 'Delete failed', body: err.message }); },
  });

  const starMutation = useMutation({
    mutationFn: (isStarred: boolean) => emailApi.toggleStar(emailId, isStarred),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email', emailId] });
      queryClient.invalidateQueries({ queryKey: ['emails'] });
    },
  });

  const unreadMutation = useMutation({
    mutationFn: () => emailApi.markRead(emailId, false),
    // Forget the cached copy too: a reopen must GET (which marks it read) and show fresh state.
    onSuccess: () => { forget(); invalidate(); onDone(); },
    onError: (err: Error) => addToast({ type: 'error', title: 'Could not mark unread', body: err.message }),
  });

  const moveMutation = useMutation({
    mutationFn: (folderId: string) => emailApi.move(emailId, folderId),
    onSuccess: () => { forget(); invalidate(); onDone(); },
    onError: (err: Error) => addToast({ type: 'error', title: 'Move failed', body: err.message }),
  });

  // ─── Loading skeleton ─────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="reading-pane">
        <div className="email-detail" style={{ padding: 'var(--space-6)' }}>
          <div className="skeleton" style={{ width: '70%', height: 28, marginBottom: 20 }} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
            <div className="skeleton" style={{ width: 40, height: 40, borderRadius: '50%' }} />
            <div>
              <div className="skeleton" style={{ width: 160, height: 16, marginBottom: 6 }} />
              <div className="skeleton" style={{ width: 200, height: 12 }} />
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 20 }}>
            <div className="skeleton" style={{ width: '100%', height: 12, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '90%', height: 12, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '60%', height: 12 }} />
          </div>
        </div>
      </div>
    );
  }

  const email = data?.data;

  if (!email) {
    return (
      <div className="reading-pane">
        <div className="reading-pane-empty">
          <div className="empty-icon">
            <IconMailEnvelope size={48} color="var(--color-text-tertiary)" />
          </div>
          <p>Email not found</p>
        </div>
      </div>
    );
  }

  const folders = foldersData?.data || [];
  const archiveFolder = folders.find((f: Folder) => f.type === 'archive');
  const moveTargets = folders.filter(
    (f: Folder) => f.type === 'custom' || f.type === 'inbox' || f.type === 'archive'
  );
  const recipients = email.recipientsTo || [];
  const ccRecipients = email.recipientsCc || [];
  const isDraft = !email.deliveryStatus && folders.find((f: Folder) => f.id === email.folderId)?.type === 'drafts';
  // Deleting from Trash is the only way to remove a message for good.
  const inTrash = folders.find((f: Folder) => f.id === email.folderId)?.type === 'trash';
  const atts = visibleAttachments(email);
  const senderKey = email.senderName || email.sender;

  return (
    <div className="reading-pane">
      {/* ─── Gmail-style icon toolbar ─────────────────────────────── */}
      <div className="email-actions">
        <button
          className="btn-icon-action"
          onClick={onClose}
          title="Back to list"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
        </button>

        <div className="action-divider" />

        {!isDraft && (
          <>
            <button className="btn-icon-action" onClick={() => openCompose({ replyTo: email })} title="Reply">
              <IconReply size={18} />
            </button>
            <button className="btn-icon-action" onClick={() => openCompose({ replyTo: email, replyAll: true })} title="Reply all">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><polyline points="13 17 8 12 13 7"/><path d="M13 12h7a4 4 0 0 1 0 8h-1"/></svg>
            </button>
            <button className="btn-icon-action" onClick={() => openCompose({ forward: email })} title="Forward">
              <IconForward size={18} />
            </button>
          </>
        )}

        {isDraft && (
          <button className="btn-icon-action" onClick={() => openCompose({ draft: email })} title="Edit draft">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
        )}

        <div className="action-divider" />

        <button
          className={`btn-icon-action${email.isStarred ? ' active' : ''}`}
          onClick={() => starMutation.mutate(!email.isStarred)}
          title={email.isStarred ? 'Unstar' : 'Star'}
        >
          <IconStar size={18} filled={email.isStarred} />
        </button>

        <button className="btn-icon-action" onClick={() => unreadMutation.mutate()} title="Mark unread">
          <IconMailEnvelope size={18} />
        </button>

        <div className="action-spacer" />

        {archiveFolder && email.folderId !== archiveFolder.id && (
          <button className="btn-icon-action" onClick={() => moveMutation.mutate(archiveFolder.id)} title="Archive">
            <IconArchive size={18} />
          </button>
        )}

        {moveTargets.length > 0 && (
          <Select
            className="move-select"
            value=""
            onValueChange={selectedValue => selectedValue && moveMutation.mutate(selectedValue)}
            aria-label="Move to folder"
          >
            <SelectOption value="">Move to…</SelectOption>
            {moveTargets
              .filter((f: Folder) => f.id !== email.folderId)
              .map((f: Folder) => (
                <SelectOption key={f.id} value={f.id}>{f.name}</SelectOption>
              ))}
          </Select>
        )}

        <button
          className="btn-icon-action"
          onClick={() => {
            if (!inTrash) deleteMutation.mutate(false);
            else if (confirm('Delete this message forever? This cannot be undone.')) deleteMutation.mutate(true);
          }}
          title={inTrash ? 'Delete forever' : 'Delete'}
        >
          <IconTrash size={18} />
        </button>
      </div>

      {/* ─── Email content ────────────────────────────────────────── */}
      <div className="email-detail">
        <div className="email-detail-header">
          {/* Subject */}
          <DeliveryStatus email={email} />
        <h1 className="email-detail-subject">{email.subject || '(no subject)'}</h1>

          {/* Sender row — Gmail-style */}
          <div className="email-detail-meta">
            <div
              className="email-avatar"
              style={{
                width: 40,
                height: 40,
                fontSize: 'var(--font-size-sm)',
                background: avatarColor(senderKey),
              }}
            >
              {initials(senderKey)}
            </div>

            <div className="email-detail-sender-info">
              <div className="email-detail-sender-row">
                <span className="email-detail-sender-name">
                  {email.senderName || email.sender.split('@')[0]}
                </span>
                <span className="email-detail-sender-email">
                  &lt;{email.sender}&gt;
                </span>
              </div>
              <div className="email-detail-recipients">
                To: {recipients.map((r) => r.name || r.email).join(', ') || '(none)'}
                {ccRecipients.length > 0 && (
                  <> • Cc: {ccRecipients.map((r) => r.name || r.email).join(', ')}</>
                )}
              </div>
            </div>

            <div className="email-detail-date">{formatFullDate(email.receivedAt)}</div>
          </div>
        </div>

        <EmailProductivityActions email={email} /><AIEmailActions emailId={email.id} />
        {/* Email body */}
        <div className="email-body">
          <EmailBody html={email.bodyHtml} text={email.bodyText} fallback={email.snippet} trusted={isOwnMail(email, folders.find((f: Folder) => f.id === email.folderId)?.type)} />
        </div>

        {/* Gmail-style attachment cards */}
        {atts.length > 0 && (
          <div className="email-attachments">
            <div className="email-attachments-label">
              <IconPaperclip size={14} />
              {atts.length} attachment{atts.length !== 1 ? 's' : ''}
            </div>
            <div className="email-attachments-grid">
              {atts.map((att: Attachment) => (
                <a
                  key={att.id}
                  href={attachmentApi.download(att.id)}
                  className="attachment-card"
                  download={att.filename}
                  rel="noopener noreferrer"
                >
                  <div
                    className="attachment-card-icon"
                    style={{ background: `${attachmentColor(att.filename)}18`, color: attachmentColor(att.filename) }}
                  >
                    <IconFile size={18} />
                  </div>
                  <div className="attachment-card-info">
                    <div className="attachment-card-name">{att.filename}</div>
                    <div className="attachment-card-size">{formatFileSize(att.size)}</div>
                  </div>
                  <IconDownload size={16} color="var(--color-text-tertiary)" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Gmail-style reply footer */}
        {!isDraft && (
          <div className="email-reply-footer">
            <button className="btn-reply-action" onClick={() => openCompose({ replyTo: email })}>
              <IconReply size={16} /> Reply
            </button>
            <button className="btn-reply-action" onClick={() => openCompose({ forward: email })}>
              <IconForward size={16} /> Forward
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
