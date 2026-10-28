import { AIWriting } from './AIQuickActions';
import RecipientInput from './RecipientInput';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachmentApi, composers, emailApi } from '../lib/api';
import { useAuthStore, useMailStore, useToastStore } from '../stores';
import type { Email, EmailAddress } from '@email-service/shared';
import { MAX_ATTACHMENT_SIZE, MAX_LARGE_FILE_SIZE, MAX_OUTBOUND_MESSAGE_SIZE, MESSAGE_OVERHEAD_BYTES, encodedMessageBytes } from '@email-service/shared';
import { IconClose, IconPaperclip, IconSend, IconFile } from './Icons';
import type { RichTextEditorHandle } from './RichTextEditor';
const RichTextEditor=lazy(()=>import('./RichTextEditor'));
import { deliveryLabel } from './DeliveryStatus';
import { visibleAttachments } from '../lib/attachments';
import type { UploadTask, UploadSnapshot } from '../lib/upload-manager';

interface ComposeModalProps {
  onClose: () => void;
}

interface PendingFile {
  /** Stable identity — the array index is unusable while uploads race. */
  key: string;
  name: string;
  size: number;
  r2Key?: string;
  /** Existing attachment carried over from a forward. */
  forwardId?: string;
  status: 'uploading' | 'ready' | 'failed';
  upload?: UploadSnapshot;
}

interface BodyValue {
  html: string;
  text: string;
}

function addressList(value: string): EmailAddress[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function quoteText(value: string): string {
  return value
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
}

/**
 * Build a proper HTML reply/forward quote that wraps the original HTML body
 * inside a Gmail-style blockquote rather than stripping it to plain text.
 */
function buildReplyHtml(
  header: string,
  originalHtml: string | undefined,
  originalText: string | undefined
): string {
  const quotedContent = originalHtml
    ? originalHtml
    : escapeHtml(originalText || '').replace(/\n/g, '<br/>');

  return (
    '<p><br/></p>' +
    '<div class="gmail_quote">' +
    '<div style="color:#5f6368;font-size:12px;margin-bottom:8px">' +
    escapeHtml(header) +
    '</div>' +
    '<blockquote style="margin:0 0 0 0;padding:0 0 0 12px;border-left:3px solid #dadce0">' +
    quotedContent +
    '</blockquote>' +
    '</div>'
  );
}

function buildForwardHtml(
  from: string,
  date: string,
  subject: string,
  originalHtml: string | undefined,
  originalText: string | undefined
): string {
  const quotedContent = originalHtml
    ? originalHtml
    : escapeHtml(originalText || '').replace(/\n/g, '<br/>');

  return (
    '<p><br/></p>' +
    '<div class="gmail_quote">' +
    '<div style="color:#5f6368;font-size:12px;margin-bottom:8px">' +
    '---------- Forwarded message ----------<br/>' +
    'From: ' + escapeHtml(from) + '<br/>' +
    'Date: ' + escapeHtml(date) + '<br/>' +
    'Subject: ' + escapeHtml(subject) +
    '</div>' +
    '<blockquote style="margin:0 0 0 0;padding:0 0 0 12px;border-left:3px solid #dadce0">' +
    quotedContent +
    '</blockquote>' +
    '</div>'
  );
}

let fileSeq = 0;

export default function ComposeModal({ onClose }: ComposeModalProps) {
  const requestId = useRef(crypto.randomUUID());
  const { composeReplyTo, composeReplyAll, composeForward, composeDraft, composeTo } = useMailStore();
  const addToast = useToastStore((s) => s.addToast);
  const currentUser = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const uploadTasks = useRef(new Map<string,UploadTask>());
  const mounted = useRef(true);
  useEffect(()=>{
    mounted.current=true;composers.open++;
    return ()=>{mounted.current=false;composers.open--;for(const task of uploadTasks.current.values())void task.cancel();};
  },[]);
  const [minimized, setMinimized] = useState(false);
  const [sendingHidden, setSendingHidden] = useState(false);
  const composeSession = useMailStore(s => s.composeSession);

  const isReply = !!composeReplyTo;
  const isForward = !!composeForward;
  const isDraft = !!composeDraft;

  // Reply-all keeps the original To/Cc, minus the current user.
  const replyRecipients = (): string => {
    if (!composeReplyTo) return '';
    if (!composeReplyAll) return composeReplyTo.sender;
    const everyone = [
      composeReplyTo.sender,
      ...composeReplyTo.recipientsTo.map((r) => r.email),
      ...composeReplyTo.recipientsCc.map((r) => r.email),
    ];
    return [...new Set(everyone)]
      .filter((address) => address.toLowerCase() !== currentUser?.email.toLowerCase())
      .join(', ');
  };

  const [to, setTo] = useState(
    isDraft ? composeDraft!.recipientsTo.map((r) => r.email).join(', ') : composeTo || replyRecipients()
  );
  const [cc, setCc] = useState(
    isDraft ? composeDraft!.recipientsCc.map((r) => r.email).join(', ') : ''
  );
  const [bcc, setBcc] = useState(
    isDraft ? composeDraft!.recipientsBcc.map((r) => r.email).join(', ') : ''
  );
  const [showCcBcc, setShowCcBcc] = useState(!!cc || !!bcc);

  const [subject, setSubject] = useState(() => {
    if (isDraft) return composeDraft!.subject;
    if (isReply) {
      return /^re:/i.test(composeReplyTo!.subject)
        ? composeReplyTo!.subject
        : 'Re: ' + composeReplyTo!.subject;
    }
    if (isForward) {
      return /^fwd:/i.test(composeForward!.subject)
        ? composeForward!.subject
        : 'Fwd: ' + composeForward!.subject;
    }
    return '';
  });

  // Build signature block once
  const signatureBlock = currentUser?.signatureHtml
    ? `<br/><div class="email-signature" data-signature="true">${currentUser.signatureHtml}</div>`
    : '';

  // The editor owns the HTML; plain text is derived for the text/plain part.
  const [initialBody] = useState<BodyValue>(() => {
    if (isDraft) {
      return { html: composeDraft!.bodyHtml || '', text: composeDraft!.bodyText || '' };
    }
    if (isForward && composeForward) {
      const plainHeader =
        '\n\n---------- Forwarded message ----------\n' +
        'From: ' + composeForward.sender + '\n' +
        'Date: ' + new Date(composeForward.receivedAt).toLocaleString() + '\n' +
        'Subject: ' + composeForward.subject + '\n\n' +
        (composeForward.bodyText || composeForward.snippet);

      const html = buildForwardHtml(
        composeForward.sender,
        new Date(composeForward.receivedAt).toLocaleString(),
        composeForward.subject,
        composeForward.bodyHtml,
        composeForward.bodyText || composeForward.snippet
      );
      // Signature goes between the cursor area and the quoted text
      return { html: '<p><br/></p>' + signatureBlock + html, text: plainHeader };
    }
    if (isReply && composeReplyTo) {
      const header =
        'On ' + new Date(composeReplyTo.receivedAt).toLocaleString() + ', ' +
        (composeReplyTo.senderName || composeReplyTo.sender) + ' wrote:';

      const plainText =
        '\n\n' + header + '\n' +
        quoteText(composeReplyTo.bodyText || composeReplyTo.snippet);

      const html = buildReplyHtml(
        header,
        composeReplyTo.bodyHtml,
        composeReplyTo.bodyText || composeReplyTo.snippet
      );
      // Signature goes between the cursor area and the quoted text
      return { html: '<p><br/></p>' + signatureBlock + html, text: plainText };
    }
    // New message: signature at bottom
    return { html: '<p><br/></p>' + signatureBlock, text: '' };
  });

  const [body, setBody] = useState<BodyValue>(initialBody);

  // Attachments carried by ID rather than re-uploaded: the server copies them
  // inside R2.
  //
  // A DRAFT's own attachments must be included too. Saving or sending a draft
  // replaces its attachment rows with whatever the payload lists, so omitting
  // them here silently destroyed every attachment on any draft the user
  // re-opened, and sent the mail without them.
  // visibleAttachments(): inline parts are already embedded in the quoted
  // body as data: URIs, so carrying them as attachments too sent the image
  // twice and showed the recipient a spurious paperclip.
  const carry = (from: Email): PendingFile[] =>
    visibleAttachments(from).map((att) => ({
      key: 'carried-' + att.id,
      name: att.filename,
      size: att.size,
      forwardId: att.id,
      status: 'ready' as const,
    }));
  const [files, setFiles] = useState<PendingFile[]>(() =>
    isForward ? carry(composeForward!) : isDraft ? carry(composeDraft!) : []
  );
  // The draft this composer saves into. Without it every Save draft made a new
  // draft, and Send left them all behind.
  const [draftId, setDraftId] = useState(composeDraft?.id);

  const buildPayload = (asDraft: boolean) => ({
    to: addressList(to),
    cc: cc ? addressList(cc) : undefined,
    bcc: bcc ? addressList(bcc) : undefined,
    subject,
    bodyHtml: body.html,
    bodyText: body.text,
    attachmentKeys: files.filter((f) => f.r2Key).map((f) => f.r2Key!),
    forwardAttachmentIds: files.filter((f) => f.forwardId).map((f) => f.forwardId!),
    // The parent's stored Message-ID (from GET /emails/:id) threads the reply.
    // A draft that was started as a reply carries its own inReplyTo, which
    // would otherwise be dropped when the draft is finally sent.
    inReplyTo: composeReplyTo?.messageId ?? composeDraft?.inReplyTo,
    isDraft: asDraft,
    draftId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['emails'] });
    queryClient.invalidateQueries({ queryKey: ['threads'] });
    // The open conversation too — otherwise a reply sent from inside a thread
    // does not appear in the thread it was sent from.
    queryClient.invalidateQueries({ queryKey: ['thread'] });
    queryClient.invalidateQueries({ queryKey: ['folders'] });
  };

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Capture editor contents before hiding the composer. Keep it mounted until
      // acceptance so a rejected request can restore the exact text and files.
      const payload = { ...buildPayload(false), requestId: requestId.current };
      const toastId = addToast({ type: 'info', title: 'Sending…', duration: 0 });
      const updateToast = useToastStore.getState().updateToast;
      setSendingHidden(true);
      let result;
      try {
        result = await emailApi.send(payload);
      } catch (error) {
        if (mounted.current) setSendingHidden(false);
        updateToast(toastId, { type: 'error', title: 'Could not confirm sending', body: error instanceof Error ? error.message : 'Please check Sent before trying again.', duration: 10_000 });
        return;
      }
      // Do not close a different composer opened while this request was pending.
      if (useMailStore.getState().composeSession === composeSession) onClose();
      invalidate();
      // This runs independently of the now-unmounted composer. Each send owns
      // its toast, so overlapping sends cannot overwrite one another's status.
      const deadline = Date.now() + 10 * 60_000;
      let polls = 0;
      while (result.data && ['queued', 'sending'].includes(result.data.deliveryStatus || '') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, polls++ < 15 ? 1_000 : 10_000));
        try {
          const latest = await emailApi.get(result.data.emailId, AbortSignal.timeout(10_000));
          if (latest.data?.deliveryStatus) result.data.deliveryStatus = latest.data.deliveryStatus;
        } catch {
          // A temporary disconnect must not turn an accepted send into a failure.
          updateToast(toastId, { type: 'info', title: 'Sending…', body: 'Waiting for confirmation. You do not need to send again.', duration: 0 });
        }
      }
      const status = result.data?.deliveryStatus;
      const pending = status === 'queued' || status === 'sending';
      updateToast(toastId, {
        type: status === 'sent' ? 'success' : pending ? 'info' : 'error',
        title: status === 'sent' ? 'Email sent' : pending ? 'Still sending' : deliveryLabel(status) || 'Could not confirm sending',
        body: status === 'sent' ? undefined : 'Open the email in Sent for details.',
        duration: status === 'sent' ? 5000 : 10_000,
      });
      invalidate();
    },
  });

  const draftMutation = useMutation({
    mutationFn: async () => {
      const saved = files.filter((f) => f.r2Key || f.forwardId).map((f) => f.key);
      return { res: await emailApi.send(buildPayload(true)), saved };
    },
    onSuccess: async ({ res, saved }) => {
      addToast({ type: 'success', title: 'Draft saved' });
      invalidate();
      // Do NOT close — let the user continue editing
      const id = res.data?.emailId;
      if (!id) return;
      setDraftId(id);
      // A cached copy would reopen the draft with its replaced attachment IDs.
      queryClient.invalidateQueries({ queryKey: ['email', id] });
      // The save copied the attachments into the draft and released the staged
      // uploads (a re-save also replaces the draft's attachment rows), so later
      // saves and Send must carry the draft's own attachments instead.
      const draft = (await emailApi.get(id).catch(() => null))?.data;
      if (draft && mounted.current) setFiles((prev) => [...carry(draft), ...prev.filter((f) => !saved.includes(f.key))]);
    },
    onError: (err: Error) =>
      addToast({ type: 'error', title: 'Failed to save draft', body: err.message }),
  });

  const handleAttachFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files || []);
      if (fileInputRef.current) fileInputRef.current.value = '';

      let attachmentBytes = files.filter(f => f.status !== 'failed').reduce((sum, f) => sum + encodedMessageBytes(f.size) + 200, 0);
      const bodyBytes = encodedMessageBytes(new TextEncoder().encode(body.html + body.text).byteLength) + MESSAGE_OVERHEAD_BYTES;
      for (const file of selected) {
        if(!mounted.current)return;
        // Large file: upload to R2 as shared download link
        if (file.size > MAX_ATTACHMENT_SIZE || bodyBytes + attachmentBytes + encodedMessageBytes(file.size) + 200 > MAX_OUTBOUND_MESSAGE_SIZE) {
          if (file.size > MAX_LARGE_FILE_SIZE) {
            addToast({
              type: 'error',
              title: 'File too large',
              body: file.name + ' exceeds ' + MAX_LARGE_FILE_SIZE / (1024 * 1024 * 1024) + ' GB limit',
            });
            continue;
          }

          const key = 'large-' + ++fileSeq;
          setFiles((prev) => [
            ...prev,
            { key, name: file.name, size: file.size, status: 'uploading' },
          ]);

          try {
            const task = attachmentApi.createLargeUpload(file, upload => {
              if(mounted.current)setFiles(prev => prev.map(item => item.key === key ? { ...item, upload } : item));
            });
            uploadTasks.current.set(key,task);
            task.start();
            const data=await task.result;
            uploadTasks.current.delete(key);
            if(!mounted.current)return;
            const res={success:true,data};
            if (res.success && res.data) {
              // Remove from file list (it's a link, not an attachment)
              setFiles((prev) => prev.filter((f) => f.key !== key));

              // Format file size for display
              const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
              const sizeLabel = file.size >= 1024 * 1024 * 1024
                ? (file.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
                : sizeMB + ' MB';

              // A plain paragraph: the editor schema has no generic div, so a
              // styled card fell apart into loose paragraphs.
              const linkHtml = `<p>📎 <a href="${escapeHtml(res.data.downloadUrl)}">${escapeHtml(file.name)}</a> (${sizeLabel})</p>`;

              // The editor owns the body; setBody alone would be overwritten by its next change.
              if (editorRef.current) {
                editorRef.current.appendHtml(linkHtml);
              } else {
                // Editor not mounted (minimized or still loading): it is recreated from body.html,
                // which also re-derives text. Same place appendHtml uses: above signature and quote.
                setBody((prev) => {
                  const at = prev.html.search(/<div class="(email-signature|gmail_quote)"/);
                  return { ...prev, html: at < 0 ? prev.html + linkHtml : prev.html.slice(0, at) + linkHtml + prev.html.slice(at) };
                });
              }

              addToast({
                type: 'success',
                title: 'Large file uploaded',
                body: `${file.name} — download link added to email body`,
              });
            }
          } catch (err) {
            uploadTasks.current.delete(key);
            if(!mounted.current)return;
            setFiles((prev) => prev.filter((f) => f.key !== key));
            if(err instanceof Error && err.name==='AbortError')continue;
            addToast({
              type: 'error',
              title: 'Upload failed',
              body: file.name + ': ' + (err instanceof Error ? err.message : 'unknown error'),
            });
          }
          continue;
        }

        // Fits the remaining MIME budget: send as an attachment.
        attachmentBytes += encodedMessageBytes(file.size) + 200;
        const key = 'file-' + ++fileSeq;
        setFiles((prev) => [
          ...prev,
          { key, name: file.name, size: file.size, status: 'uploading' },
        ]);

        try {
          const res = await attachmentApi.upload(file);
          setFiles((prev) =>
            prev.map((f) =>
              f.key === key ? { ...f, r2Key: res.data?.r2Key, status: 'ready' as const } : f
            )
          );
        } catch (err) {
          setFiles((prev) =>
            prev.map((f) => (f.key === key ? { ...f, status: 'failed' as const } : f))
          );
          addToast({
            type: 'error',
            title: 'Upload failed',
            body: file.name + ': ' + (err instanceof Error ? err.message : 'unknown error'),
          });
        }
      }
    },
    [addToast, files, body]
  );

  const removeFile = (key: string) => setFiles((prev) => prev.filter((f) => f.key !== key));

  const uploading = files.some((f) => f.status === 'uploading');
  const busy = sendMutation.isPending || draftMutation.isPending;
  const composeDialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (minimized || sendingHidden) return;
    const previous = document.activeElement as HTMLElement | null;
    composeDialog.current?.querySelector<HTMLInputElement>('#compose-to')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [minimized, sendingHidden]);

  return (
    <div style={sendingHidden ? { display: 'none' } : undefined} className={`compose-overlay ${minimized ? 'compose-overlay--minimized' : ''}`} onClick={minimized ? undefined : () => setMinimized(true)}>
      <div
        ref={composeDialog}
        className={`compose-modal ${minimized ? 'compose-modal--minimized' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={e => {
          if (minimized || e.defaultPrevented || composeDialog.current?.querySelector('[role="listbox"]')) return;
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMinimized(true); }
          if (e.key === 'Tab') {
            const fields = Array.from(composeDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [contenteditable="true"], a[href]') || []).filter(el => el.tabIndex >= 0 && el.getClientRects().length > 0);
            const first = fields[0], last = fields[fields.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
          }
        }}
        role="dialog"
        aria-modal={!minimized || undefined}
        aria-label="Compose message"
      >
        <div
          className="compose-header"
          onClick={() => setMinimized((v) => !v)}
          style={{ cursor: 'pointer' }}
        >
          <h3>
            {isDraft ? 'Edit Draft' : isReply ? 'Reply' : isForward ? 'Forward' : 'New Message'}
          </h3>
          <div className="compose-header-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setMinimized((v) => !v)}
              aria-label={minimized ? 'Maximize' : 'Minimize'}
              title={minimized ? 'Maximize' : 'Minimize'}
            >
              {minimized ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" /></svg>
              )}
            </button>
            <button className="btn btn-ghost btn-icon" onClick={uploading ? ()=>setMinimized(true) : onClose} aria-label={uploading ? 'Minimize while uploading' : 'Close'}>
              <IconClose size={18} />
            </button>
          </div>
        </div>

        {!minimized && (
          <>
            <div className="compose-fields">
              <form id="compose-recipient-form" onSubmit={(e) => e.preventDefault()} />
              <div className="compose-field">
                <label htmlFor="compose-to">To</label>
                <RecipientInput id="compose-to" value={to} onChange={setTo} />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowCcBcc((v) => !v)}
                >
                  Cc/Bcc
                </button>
              </div>

              {showCcBcc && (
                <>
                  <div className="compose-field">
                    <label htmlFor="compose-cc">Cc</label>
                    <RecipientInput id="compose-cc" value={cc} onChange={setCc} />
                  </div>
                  <div className="compose-field">
                    <label htmlFor="compose-bcc">Bcc</label>
                    <RecipientInput id="compose-bcc" value={bcc} onChange={setBcc} />
                  </div>
                </>
              )}

              <div className="compose-field">
                <label htmlFor="compose-subject">Subject</label>
                <input
                  id="compose-subject"
                  name="message-subject"
                  form="compose-recipient-form"
                  autoComplete="off"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
            </div>

            <AIWriting body={body} onReplace={html=>editorRef.current?.replaceHtml(html)}/>
            <div className="compose-body">
              <Suspense fallback={<p role="status">Loading editor…</p>}><RichTextEditor
                ref={editorRef}
                // Minimizing unmounts the editor; restoring from initialBody discarded everything typed.
                initialHtml={body.html}
                onChange={setBody}
                placeholder="Write your message..."
                autoFocus={isReply}
              /></Suspense>
            </div>

            {files.length > 0 && (
              <div className="compose-attachments">
                {files.map((file) => (
                  <div
                    key={file.key}
                    className={
                      'attachment-chip' + (file.upload ? ' attachment-upload' : '') + (file.status === 'failed' ? ' attachment-failed' : '')
                    }
                  >
                    {file.status === 'uploading' ? (
                      <span className="loading-spinner" style={{ width: 12, height: 12 }} />
                    ) : (
                      <IconFile size={14} />
                    )}
                    <span className="attachment-filename">{file.name}</span>
                    {file.upload && <>
                      <progress max={100} value={file.upload.percent} aria-label={`Upload progress for ${file.name}`} />
                      <span className="upload-details">
                        {file.upload.phase==='uploading' ? `${file.upload.percent}%${file.upload.retrying ? ' · Retrying a chunk' : ''}` :
                          ({preparing:'Preparing…',paused:'Paused',offline:'Waiting for connection…',error:'Upload interrupted',finishing:'Finishing…',cancelling:'Cancelling…',cancelled:'Cancelled',complete:'Complete'} as Record<string,string>)[file.upload.phase]}
                        {file.upload.bytesPerSecond>0 && ` · ${(file.upload.bytesPerSecond/1024/1024).toFixed(2)} MB/s`}
                        {file.upload.secondsRemaining!==undefined && ` · About ${file.upload.secondsRemaining<60 ? `${Math.max(1,Math.ceil(file.upload.secondsRemaining))}s` : `${Math.ceil(file.upload.secondsRemaining/60)} min`} left`}
                      </span>
                      {file.upload.error && <span className="upload-error" role="alert">{file.upload.error}</span>}
                      <span className="upload-controls">
                        {['preparing','uploading','offline'].includes(file.upload.phase) && <button type="button" className="btn btn-ghost btn-sm" onClick={()=>uploadTasks.current.get(file.key)?.pause()}>Pause</button>}
                        {['paused','error'].includes(file.upload.phase) && <button type="button" className="btn btn-ghost btn-sm" onClick={()=>uploadTasks.current.get(file.key)?.resume()}>{file.upload.phase==='error'?'Retry':'Resume'}</button>}
                        <button type="button" className="btn btn-ghost btn-sm" disabled={file.upload.phase==='finishing' || file.upload.phase==='complete'} onClick={()=>{void uploadTasks.current.get(file.key)?.cancel();}}>Cancel</button>
                      </span>
                    </>}
                    {file.status === 'failed' && <span> — failed</span>}
                    {!file.upload && <button
                      type="button"
                      onClick={() => removeFile(file.key)}
                      aria-label={'Remove ' + file.name}
                      className="attachment-remove"
                      disabled={file.status === 'uploading' || busy}
                    >
                      <IconClose size={12} />
                    </button>}
                  </div>
                ))}
              </div>
            )}

            {uploading && <p className="upload-session-hint">Keep this tab open. Paused uploads and connection interruptions resume from confirmed chunks.</p>}

            <div className="compose-footer">
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  disabled={uploading}
                  multiple
                  onChange={handleAttachFile}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconPaperclip size={16} /> Attach
                </button>
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => draftMutation.mutate()}
                  disabled={busy || uploading}
                >
                  {draftMutation.isPending ? (
                    <span className="loading-spinner" style={{ width: 14, height: 14 }} />
                  ) : (
                    'Save draft'
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => sendMutation.mutate()}
                  disabled={busy || uploading || !to.trim()}
                  title={uploading ? 'Waiting for attachments to finish uploading' : undefined}
                >
                  {sendMutation.isPending ? (
                    <span className="loading-spinner" style={{ width: 16, height: 16 }} />
                  ) : (
                    <>
                      <IconSend size={16} /> Send
                    </>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
