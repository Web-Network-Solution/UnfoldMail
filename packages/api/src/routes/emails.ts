import type { Database } from "../services/mailbox-storage";
import { Hono } from 'hono';
import type { Env, HonoVariables } from '../types';
import {
  generateUUIDv7,
  emailBodyKey,
  emailBodyTextKey,
  extractSnippet,
  normalizeRecipients,
  nowIso,
} from '../lib/utils';
import { ftsDeleteStatement, ftsInsertStatement } from '../lib/fts';
import { mapAttachment, mapEmail, type AttachmentRow, type EmailRow } from '../lib/mappers';
import {
  SendError,
  encodedSize,
  materializeAttachments,
  releaseStagedUploads,
  withSignature,
  withSignatureText,
} from '../services/email-sender';
import { DEFAULT_PAGE_SIZE, MAX_OUTBOUND_MESSAGE_SIZE, MAX_PAGE_SIZE, MAX_RECIPIENTS, MESSAGE_OVERHEAD_BYTES, encodedMessageBytes } from '@email-service/shared';

import { retainSharedFiles, sharedFileStatements } from '../services/shared-files';
import type { OutboundPayload } from '../services/outbox';

const emails = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

// ══════════════════════════════════════════════════════════════════
// IMPORTANT: Non-parameterized routes (/threads, /send) MUST be
// registered BEFORE /:id routes, otherwise Hono matches "threads"
// as an :id parameter and returns 404.
// ══════════════════════════════════════════════════════════════════

function parsePaging(c: { req: { query: (k: string) => string | undefined } }) {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * The single place an email changes folder.
 *
 * `folder_id`, `trashed_at` and `is_archived` must move together, and they used
 * to be set independently by /move and by DELETE: a soft-delete left
 * `is_archived = 1` on archived mail (hiding it from default search while it
 * sat in Trash), and moving mail *out* of Archive cleared the flag so the next
 * nightly run archived it straight back.
 *
 * Folder membership is the source of truth; `is_archived` is derived from it.
 * `trashed_at` is stamped on entering Trash, kept when the message is already
 * there (so the purge clock is not restarted), and cleared by any other move.
 */
function moveToFolder(
  db: Database,
  userId: string,
  emailId: string,
  folderId: string,
  folderType: string
): Promise<D1Result> {
  const isArchived = folderType === 'archive' ? 1 : 0;

  if (folderType === 'trash') {
    return db
      .prepare(
        `UPDATE emails SET folder_id = ?, is_archived = ?,
          trashed_at = CASE WHEN folder_id = ? AND trashed_at IS NOT NULL THEN trashed_at ELSE ? END
         WHERE id = ? AND user_id = ?`
      )
      .bind(folderId, isArchived, folderId, nowIso(), emailId, userId)
      .run();
  }

  // Any move outside Trash clears the clock.
  return db
    .prepare(
      'UPDATE emails SET folder_id = ?, is_archived = ?, trashed_at = NULL WHERE id = ? AND user_id = ?'
    )
    .bind(folderId, isArchived, emailId, userId)
    .run();
}

/** Look up one of the caller's system folders. */
async function systemFolderId(
  db: Database,
  userId: string,
  type: 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive'
): Promise<string | null> {
  const row = await db
    .prepare('SELECT id FROM folders WHERE user_id = ? AND type = ?')
    .bind(userId, type)
    .first<{ id: string }>();
  return row?.id || null;
}

// ─── List Threads ─────────────────────────────────────────────────

emails.get('/threads', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.query('folderId');
  const { page, pageSize, offset } = parsePaging(c);
  const params: unknown[] = folderId ? [userId, folderId] : [userId];
  const where = folderId ? 'WHERE t.user_id = ? AND t.folder_id = ?' : 'WHERE t.user_id = ?';
  // A folder uses the maintained index directly; the all-mail view groups only summaries.
  const source = folderId ? `SELECT t.* FROM mailbox_threads t ${where}` :
    `SELECT t.user_id, t.thread_id, MAX(t.last_message_at) AS last_message_at,
      substr(MAX(t.last_message_at || char(31) || t.latest_email_id), length(MAX(t.last_message_at)) + 2) AS latest_email_id,
      SUM(t.message_count) AS message_count, SUM(t.unread_count) AS unread_count,
      MAX(t.has_attachments) AS has_attachments, GROUP_CONCAT(t.participants) AS participants
     FROM mailbox_threads t ${where} GROUP BY t.user_id, t.thread_id`;
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (${source})`).bind(...params).first<{ n: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT t.*, e.subject, e.snippet, e.delivery_status FROM (${source}) t JOIN emails e ON e.id = t.latest_email_id
     ORDER BY t.last_message_at DESC, t.thread_id DESC LIMIT ? OFFSET ?`
  ).bind(...params, pageSize, offset).all<{
    thread_id: string; subject: string; snippet: string; last_message_at: string;
    message_count: number; unread_count: number; has_attachments: number; participants: string;
    delivery_status: string | null;
  }>();
  return c.json({ success: true, data: rows.results.map(t => ({
    id: t.thread_id, subject: t.subject, snippet: t.snippet, lastMessageAt: t.last_message_at,
    messageCount: t.message_count, unreadCount: t.unread_count, hasAttachments: !!t.has_attachments,
    participants: [...new Set(t.participants.split(','))], deliveryStatus: t.delivery_status,
  })), pagination: { page, pageSize, total: total?.n || 0, totalPages: Math.ceil((total?.n || 0) / pageSize) } });
});

// Fetch metadata only. Bodies and attachments are fetched by /:id when expanded.
emails.get('/threads/:threadId', async (c) => {
  const userId = c.get('userId');
  const threadId = c.req.param('threadId');
  const before = c.req.query('before');
  const params: unknown[] = [userId, threadId];
  let cursorFilter = '';
  if (before) {
    const cursor = await c.env.DB.prepare('SELECT received_at, id FROM emails WHERE id = ? AND user_id = ? AND thread_id = ?')
      .bind(before, userId, threadId).first<{ received_at: string; id: string }>();
    if (!cursor) return c.json({ success: false, error: 'Conversation cursor no longer exists. Refresh the conversation.' }, 400);
    cursorFilter = ' AND (received_at, id) < (?, ?)';
    params.push(cursor.received_at, cursor.id);
  }
  const rows = await c.env.DB.prepare(`SELECT * FROM emails WHERE user_id = ? AND thread_id = ?${cursorFilter} ORDER BY received_at DESC, id DESC LIMIT 26`)
    .bind(...params).all<EmailRow>();
  if (!rows.results.length && !before) return c.json({ success: false, error: 'Conversation not found' }, 404);
  const page = rows.results.slice(0, 25);
  const nextCursor = rows.results.length > 25 ? page[page.length - 1].id : undefined;
  return c.json({ success: true, data: { id: threadId, emails: page.reverse().map(row => mapEmail(row)), nextCursor } });
});

// ─── Send / Compose Email ─────────────────────────────────────────

emails.post('/send', async (c) => {
  const userId = c.get('userId');
  const userEmail = c.get('userEmail');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }
  if (!body || typeof body !== 'object') return c.json({ success: false, error: 'Invalid JSON body' }, 400);

  const {
    subject,
    bodyHtml,
    bodyText,
    attachmentKeys,
    forwardAttachmentIds,
    inReplyTo,
    isDraft,
    draftId,
  } = body as {
    subject?: string;
    bodyHtml?: string;
    bodyText?: string;
    attachmentKeys?: string[];
    forwardAttachmentIds?: string[];
    inReplyTo?: string;
    isDraft?: boolean;
    draftId?: string;
  };
  // The cast checks nothing at runtime: wrong types reached string methods and
  // bind() as 500s, and isDraft:"false" silently saved a draft. null = omitted.
  const text = (v: unknown) => v == null || typeof v === 'string';
  const list = (v: unknown) => v == null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (![subject, bodyHtml, bodyText, inReplyTo, draftId].every(text) || ![attachmentKeys, forwardAttachmentIds].every(list) ||
    !(isDraft == null || typeof isDraft === 'boolean')) {
    return c.json({ success: false, error: 'Invalid message fields' }, 400);
  }

  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  if (requestId && !/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) return c.json({ success: false, error: 'Invalid request ID' }, 400);
  if (!isDraft && requestId) {
    const saved = await c.env.DB.prepare('SELECT e.id, e.thread_id, e.delivery_status FROM outbound_jobs j JOIN emails e ON e.id = j.email_id WHERE j.user_id = ? AND j.request_id = ?')
      .bind(userId, requestId).first<{ id: string; thread_id: string; delivery_status: string }>();
    if (saved) return c.json({ success: true, data: { emailId: saved.id, threadId: saved.thread_id, deliveryStatus: saved.delivery_status, isDraft: false } });
  }

  const to = normalizeRecipients(body.to);
  const cc = normalizeRecipients(body.cc);
  const bcc = normalizeRecipients(body.bcc);
  const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid];

  // Validate before writing anything. Previously a malformed recipient list
  // still produced a row in Sent, so the user saw a "sent" email that never was.
  if (invalid.length > 0) {
    return c.json(
      { success: false, error: `Invalid email address${invalid.length > 1 ? 'es' : ''}: ${invalid.join(', ')}` },
      400
    );
  }
  if (!isDraft && to.valid.length + cc.valid.length + bcc.valid.length === 0) {
    return c.json({ success: false, error: 'At least one recipient is required' }, 400);
  }

  // Cloudflare Email Sending refuses a From address outside the onboarded
  // domain, and the refusal surfaces as an opaque 502 after the message has
  // already been assembled. Fail fast with something actionable instead.
  // (EMAIL_DOMAIN was a required SETUP.md value that no code read at all.)
  if (c.env.EMAIL_DOMAIN && !userEmail.toLowerCase().endsWith(`@${c.env.EMAIL_DOMAIN.toLowerCase()}`)) {
    return c.json(
      {
        success: false,
        error: `Cannot send from ${userEmail}: Email Sending only accepts addresses on ${c.env.EMAIL_DOMAIN}.`,
      },
      400
    );
  }

  if (to.valid.length + cc.valid.length + bcc.valid.length > MAX_RECIPIENTS) {
    return c.json({ success: false, error: 'At most 50 recipients are allowed' }, 400);
  }
  if ((subject || '').length > 998) return c.json({ success: false, error: 'Subject is too long' }, 400);

  const user = await c.env.DB.prepare(
    'SELECT display_name, signature_html FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{ display_name: string; signature_html: string | null }>();

  const folderType = isDraft ? 'drafts' : 'sent';
  const folderId = await systemFolderId(c.env.DB, userId, folderType);
  if (!folderId) {
    return c.json({ success: false, error: `${folderType} folder not found` }, 500);
  }

  // Reuse the row when overwriting an existing draft, so repeated saves do not
  // pile up duplicate drafts.
  let emailId = generateUUIDv7();
  let existingDraft: { id: string; thread_id: string; r2_body_key: string } | null = null;

  if (draftId) {
    existingDraft = await c.env.DB.prepare(
      `SELECT e.id, e.thread_id, e.r2_body_key FROM emails e
       JOIN folders f ON f.id = e.folder_id
       WHERE e.id = ? AND e.user_id = ? AND f.type = 'drafts' AND e.delivery_status IS NULL`
    )
      .bind(draftId, userId)
      .first<{ id: string; thread_id: string; r2_body_key: string }>();

    if (!existingDraft) return c.json({ success: false, error: 'Draft not found' }, 404);
    if (isDraft) emailId = existingDraft.id;
  }

  // The parent supplies both the thread and the References chain to extend.
  const parent = inReplyTo
    ? await c.env.DB.prepare(
        'SELECT thread_id, message_id, references_chain FROM emails WHERE message_id = ? AND user_id = ? LIMIT 1'
      )
        .bind(inReplyTo, userId)
        .first<{ thread_id: string; message_id: string | null; references_chain: string | null }>()
    : null;

  const threadId = existingDraft?.thread_id || parent?.thread_id || generateUUIDv7();

  // RFC 5322: References is the parent's chain plus the parent's own
  // Message-ID. Sending only the immediate parent (as this used to) breaks
  // threading in clients that walk the chain.
  const referencesChain =
    [parent?.references_chain, parent?.message_id || inReplyTo]
      .filter(Boolean)
      .join(' ')
      .trim() || null;

  // The signature is applied at send time only. A draft stores the raw body,
  // because a draft is re-opened into the compose box and saved again — and
  // appending the signature on every save compounded it into N copies in the
  // message the recipient finally received.
  const signature = user?.signature_html || '';
  const finalHtml = isDraft ? bodyHtml || '' : withSignature(bodyHtml || '', signature);
  const finalText = isDraft ? bodyText || '' : withSignatureText(bodyText || '', signature, bodyHtml || '');
  const snippet = extractSnippet(bodyText || bodyHtml || '');
  const sentAt = nowIso();
  let sharedStatements: D1PreparedStatement[];
  try {
    sharedStatements = await sharedFileStatements(c.env, emailId, userId, finalHtml, finalText);
  } catch (error) {
    return c.json({ success: false, error: error instanceof Error ? error.message : 'Shared file validation failed' }, 400);
  }

  // The size ceiling is enforced inside materializeAttachments as each file is
  // pulled in — which never ran for a message with no attachments, so a
  // multi-megabyte pasted HTML body sailed past validation and was rejected by
  // Cloudflare instead.
  const bodyBytes = encodedMessageBytes(new TextEncoder().encode(finalHtml + finalText).byteLength) + MESSAGE_OVERHEAD_BYTES;
  if (bodyBytes > MAX_OUTBOUND_MESSAGE_SIZE) {
    return c.json(
      {
        success: false,
        error: `Message body exceeds the ${MAX_OUTBOUND_MESSAGE_SIZE / (1024 * 1024)} MB limit`,
      },
      413
    );
  }

  // ─── Attachments ──────────────────────────────────────────────
  let attachments;
  try {
    attachments = await materializeAttachments(
      c.env,
      userId,
      emailId,
      Array.isArray(attachmentKeys) ? attachmentKeys : [],
      Array.isArray(forwardAttachmentIds) ? forwardAttachmentIds : [],
      // The body counts toward the 5 MiB ceiling too.
      bodyBytes
    );
  } catch (err) {
    if (err instanceof SendError) return c.json({ success: false, error: err.message }, err.status);
    throw err;
  }

  // Persist the message and outbox job atomically before any delivery attempt.
  const messageId: string | undefined = undefined;

  const bodyKey = isDraft
    ? `emails/${userId}/${emailId}/revisions/${crypto.randomUUID()}/body.html`
    : emailBodyKey(userId, emailId);
  const bodyTextR2Key = emailBodyTextKey(userId, emailId, bodyKey);

  // Store what was actually sent, signature included.
  const bodyWrites = await Promise.allSettled([
    c.env.EMAIL_BUCKET.put(bodyKey, finalHtml, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    }),
    c.env.EMAIL_BUCKET.put(bodyTextR2Key, finalText, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    }),
  ]);
  const failedBody = bodyWrites.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failedBody) {
    await releaseStagedUploads(c.env, [bodyKey, bodyTextR2Key, ...attachments.map(a => a.r2Key)]);
    throw failedBody.reason;
  }

  // Encoded size, matching what actually goes on the wire.
  const size =
    new TextEncoder().encode(finalHtml + finalText).byteLength +
    attachments.reduce((sum, a) => sum + encodedSize(a.size), 0);

  const statements: D1PreparedStatement[] = [];
  if (existingDraft) {
    // The CHECK failure aborts the whole batch if another save/send/delete won,
    // instead of updating attachments/FTS belonging to a different revision.
    statements.push(c.env.DB.prepare(`INSERT INTO mailbox_write_guard(valid)
      SELECT CASE WHEN EXISTS(SELECT 1 FROM emails e JOIN folders f ON f.id=e.folder_id
        WHERE e.id=? AND e.user_id=? AND e.r2_body_key=? AND f.type='drafts' AND e.delivery_status IS NULL)
      THEN 1 ELSE 0 END`).bind(existingDraft.id,userId,existingDraft.r2_body_key),
      c.env.DB.prepare('DELETE FROM mailbox_write_guard'));
  }
  /** Previous-revision attachment objects, deleted only after the batch commits. */
  let staleAttachmentKeys: string[] = [];

  if (existingDraft && isDraft) {
    // Identify the previous revision's now-unreferenced attachment objects.
    // They are deleted AFTER the batch commits, not before: deleting first
    // meant a failed batch left the draft's rows intact while their files were
    // already gone, so re-opening the draft showed attachments that 404 on
    // download. Deferred cleanup can only leak, never destroy.
    const previous = await c.env.DB.prepare(
      'SELECT r2_key FROM attachments WHERE email_id = ?'
    )
      .bind(emailId)
      .all<{ r2_key: string }>();

    staleAttachmentKeys = previous.results
      .map((a) => a.r2_key)
      .filter((key) => !attachments.some((a) => a.r2Key === key));
    staleAttachmentKeys.push(existingDraft.r2_body_key.replace(/body\.html$/, 'protocol.eml'), existingDraft.r2_body_key, emailBodyTextKey(userId,emailId,existingDraft.r2_body_key));

    statements.push(
      c.env.DB.prepare(
        `UPDATE emails SET folder_id = ?, recipients_to = ?, recipients_cc = ?, recipients_bcc = ?,
          subject = ?, snippet = ?, has_attachments = ?, size = ?, message_id = ?,
          in_reply_to = ?, references_chain = ?, received_at = ?, r2_body_key = ?
         WHERE id = ? AND user_id = ?`
      ).bind(
        folderId,
        JSON.stringify(to.valid),
        JSON.stringify(cc.valid),
        JSON.stringify(bcc.valid),
        subject || '',
        snippet,
        attachments.some((a) => a.disposition !== 'inline') ? 1 : 0,
        size,
        messageId || null,
        inReplyTo || null,
        referencesChain,
        sentAt,
        bodyKey,
        emailId,
        userId
      ),
      // Attachments and FTS are rewritten rather than merged — simpler than
      // diffing, and a draft has at most a handful of rows.
      c.env.DB.prepare('DELETE FROM attachments WHERE email_id = ?').bind(emailId),
      ftsDeleteStatement(c.env.DB, emailId)
    );
  } else {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO emails (id, thread_id, folder_id, user_id, sender, sender_name,
          recipients_to, recipients_cc, recipients_bcc, subject, snippet, r2_body_key,
          is_read, has_attachments, size, message_id, in_reply_to, references_chain, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
      ).bind(
        emailId,
        threadId,
        folderId,
        userId,
        userEmail,
        user?.display_name || '',
        JSON.stringify(to.valid),
        JSON.stringify(cc.valid),
        JSON.stringify(bcc.valid),
        subject || '',
        snippet,
        bodyKey,
        attachments.some((a) => a.disposition !== 'inline') ? 1 : 0,
        size,
        messageId || null,
        inReplyTo || null,
        referencesChain,
        sentAt
      )
    );
  }

  for (const att of attachments) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO attachments (id, email_id, filename, mime_type, size, r2_key, created_at, content_id, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        att.id,
        emailId,
        att.filename,
        att.mimeType,
        att.size,
        att.r2Key,
        sentAt,
        att.contentId || null,
        att.disposition
      )
    );
  }

  statements.push(
    ftsInsertStatement(c.env.DB, {
      emailId,
      userId,
      subject: subject || '',
      sender: userEmail,
      snippet,
    })
  );

  statements.push(...sharedStatements);

  if (!isDraft) {
    const payload: OutboundPayload = {
      from: { email: userEmail, name: user?.display_name || '' },
      to: to.valid, cc: cc.valid, bcc: bcc.valid, subject: subject || '',
      inReplyTo, references: referencesChain || undefined, bodyKey,
      attachments: attachments.map(({ content, ...metadata }) => metadata),
    };
    statements.push(
      c.env.DB.prepare("UPDATE emails SET delivery_status = 'queued', delivery_error = NULL WHERE id = ?").bind(emailId),
      c.env.DB.prepare('INSERT INTO outbound_jobs (email_id, user_id, payload, next_attempt_at, updated_at, request_id, source_draft_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(emailId, userId, JSON.stringify(payload), sentAt, sentAt, requestId || null, existingDraft?.id || null)
    );
  }
  if (!isDraft && existingDraft) {
    const oldAttachments = await c.env.DB.prepare('SELECT r2_key FROM attachments WHERE email_id = ?').bind(existingDraft.id).all<{ r2_key: string }>();
    staleAttachmentKeys.push(existingDraft.r2_body_key.replace(/body\.html$/, 'protocol.eml'), ...oldAttachments.results.map(a => a.r2_key), existingDraft.r2_body_key, emailBodyTextKey(userId, existingDraft.id, existingDraft.r2_body_key));
    statements.push(c.env.DB.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?').bind(existingDraft.id, userId), ftsDeleteStatement(c.env.DB, existingDraft.id));
  }
  try { await c.env.DB.batch(statements); }
  catch (error) {
    // A lost RPC response is not a rollback. Check this attempt's identity even
    // when the API caller omitted requestId. If this read fails, preserve R2.
    const own = await c.env.DB.prepare('SELECT id,thread_id,delivery_status,r2_body_key FROM emails WHERE id=? AND user_id=?')
      .bind(emailId,userId).first<{id:string;thread_id:string;delivery_status:string|null;r2_body_key:string}>();
    if (own?.r2_body_key === bodyKey) {
      if (!isDraft) await retainSharedFiles(c.env, finalHtml, finalText);
      return c.json({success:true,data:{emailId:own.id,threadId:own.thread_id,deliveryStatus:own.delivery_status,isDraft:!!isDraft,attachmentCount:attachments.length}});
    }
    if (!isDraft) {
      // A concurrent retry may have committed first. Return that job, never send twice.
      const saved = await c.env.DB.prepare('SELECT e.id, e.thread_id, e.delivery_status FROM outbound_jobs j JOIN emails e ON e.id = j.email_id WHERE j.user_id = ? AND ((? IS NOT NULL AND j.request_id = ?) OR (? IS NOT NULL AND j.source_draft_id = ?))')
        .bind(userId, requestId || null, requestId || null, existingDraft?.id || null, existingDraft?.id || null)
        .first<{ id: string; thread_id: string; delivery_status: string }>();
      // These objects have a fresh email ID, so deleting them cannot affect the winning send or draft.
      if (saved?.id !== emailId) await Promise.all([bodyKey, bodyTextR2Key, ...attachments.map(a => a.r2Key)].map(key => c.env.EMAIL_BUCKET.delete(key).catch(() => undefined)));
      if (saved) return c.json({ success: true, data: { emailId: saved.id, threadId: saved.thread_id, deliveryStatus: saved.delivery_status, isDraft: false } });
    } else {
      await releaseStagedUploads(c.env, [bodyKey,bodyTextR2Key,...attachments.map(a=>a.r2Key)]);
    }
    if (error instanceof Error && /CHECK constraint failed.*valid/i.test(error.message)) return c.json({success:false,error:'This draft changed or was removed. Reopen it before saving or sending again.'},409);
    throw error;
  }
  if (!isDraft) {
    await retainSharedFiles(c.env, finalHtml, finalText);
    try { await c.env.OUTBOUND_QUEUE.send({ kind: 'outbound', emailId, userId }); }
    catch (error) { console.error('Outbox saved; scheduled dispatch will retry publication', error); }
  }

  // The durable message has its own copies, so staging and superseded draft
  // objects can now be released without affecting delivery retries.
  await releaseStagedUploads(c.env, [
    ...(Array.isArray(attachmentKeys) ? attachmentKeys : []),
    ...staleAttachmentKeys,
  ]);

  return c.json({
    success: true,
    data: { emailId, threadId, messageId, deliveryStatus: isDraft ? undefined : 'queued', isDraft: !!isDraft, attachmentCount: attachments.length },
  });
});

emails.post('/:id/retry', async (c) => {
  const emailId = c.req.param('id');
  const userId = c.get('userId');
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE emails SET delivery_status = 'queued', delivery_error = NULL WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM outbound_jobs WHERE email_id = emails.id AND status = 'failed')").bind(emailId, userId),
    c.env.DB.prepare("UPDATE outbound_jobs SET status = 'queued', attempts = 0, next_attempt_at = ?, updated_at = ? WHERE email_id = ? AND user_id = ? AND status = 'failed'")
      .bind(nowIso(), nowIso(), emailId, userId),
  ]);
  if (!results[1].meta.changes) return c.json({ success: false, error: 'Only a confirmed failed message can be retried' }, 409);
  try { await c.env.OUTBOUND_QUEUE.send({ kind: 'outbound', emailId, userId }); }
  catch (error) { console.error('Scheduled dispatch will retry', error); }
  return c.json({ success: true });
});

emails.post('/:id/resolve-delivery', async (c) => {
  const body = await c.req.json<{ outcome?: string }>().catch(() => ({} as { outcome?: string }));
  if (body.outcome !== 'delivered' && body.outcome !== 'not_delivered') return c.json({ success: false, error: 'Confirm whether the recipient received the message' }, 400);
  const status = body.outcome === 'delivered' ? 'sent' : 'failed';
  const detail = body.outcome === 'delivered' ? null : 'You confirmed this message was not delivered. You can retry it.';
  const id = c.req.param('id');
  const userId = c.get('userId');
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE emails SET delivery_status = ?, delivery_error = ? WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM outbound_jobs WHERE email_id = emails.id AND status = 'uncertain')").bind(status, detail, id, userId),
    c.env.DB.prepare("UPDATE outbound_jobs SET status = ?, updated_at = ? WHERE email_id = ? AND user_id = ? AND status = 'uncertain'").bind(status, nowIso(), id, userId),
  ]);
  if (!results[1].meta.changes) return c.json({ success: false, error: 'This delivery does not need manual resolution' }, 409);
  return c.json({ success: true });
});

// ─── List Emails in Folder ────────────────────────────────────────

emails.get('/', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.query('folderId');
  const starred = c.req.query('starred');
  const { page, pageSize, offset } = parsePaging(c);

  const filters = ['e.user_id = ?'];
  const params: unknown[] = [userId];
  if (folderId) {
    filters.push('e.folder_id = ?');
    params.push(folderId);
  }
  if (starred === 'true') {
    filters.push('e.is_starred = 1');
  }
  const where = `WHERE ${filters.join(' AND ')}`;

  const countResult = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM emails e ${where}`)
    .bind(...params)
    .first<{ total: number }>();

  const total = countResult?.total || 0;

  const result = await c.env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id AND a.disposition != 'inline') AS attachment_count
     FROM emails e
     ${where}
     ORDER BY e.received_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, pageSize, offset)
    .all<EmailRow & { attachment_count: number }>();

  return c.json({
    success: true,
    data: result.results.map((row) => mapEmail(row, { attachmentCount: row.attachment_count })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
});

// ─── Get Single Email (with body from R2) ─────────────────────────

emails.get('/:id', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('id');

  const email = await c.env.DB.prepare('SELECT * FROM emails WHERE id = ? AND user_id = ?')
    .bind(emailId, userId)
    .first<EmailRow>();

  if (!email) return c.json({ success: false, error: 'Email not found' }, 404);

  const [bodyObj, textObj, attachments] = await Promise.all([
    c.env.EMAIL_BUCKET.get(email.r2_body_key),
    c.env.EMAIL_BUCKET.get(emailBodyTextKey(userId, emailId, email.r2_body_key)),
    c.env.DB.prepare('SELECT * FROM attachments WHERE email_id = ? ORDER BY created_at ASC')
      .bind(emailId)
      .all<AttachmentRow>(),
  ]);

  if (!email.is_read) {
    await c.env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ? AND user_id = ?')
      .bind(emailId, userId)
      .run();
  }

  return c.json({
    success: true,
    // `markedRead` tells the client whether this request actually changed the
    // unread state. Without it the client cannot distinguish "I just cleared a
    // bold row" from "this was already read", so it had to refetch the email
    // list and folder counts on every single open.
    markedRead: !email.is_read,
    data: mapEmail(email, {
      isRead: true,
      bodyHtml: bodyObj ? await bodyObj.text() : '',
      bodyText: textObj ? await textObj.text() : '',
      attachments: attachments.results.map(mapAttachment),
      // Inline parts are rendered inside the body, so they must not inflate the
      // paperclip count the way they did in the list view.
      attachmentCount: attachments.results.filter((a) => a.disposition !== 'inline').length,
    }),
  });
});

// ─── Mark Read/Unread ─────────────────────────────────────────────

emails.patch('/:id/read', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('id');
  const { isRead } = await c.req.json<{ isRead?: unknown }>().catch(() => null) || {};
  if (typeof isRead !== 'boolean') return c.json({ success: false, error: 'isRead must be true or false' }, 400);

  const result = await c.env.DB.prepare(
    'UPDATE emails SET is_read = ? WHERE id = ? AND user_id = ?'
  )
    .bind(isRead ? 1 : 0, emailId, userId)
    .run();

  if (!result.meta?.changes) return c.json({ success: false, error: 'Email not found' }, 404);
  return c.json({ success: true });
});

// ─── Star/Unstar ──────────────────────────────────────────────────

emails.patch('/:id/star', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('id');
  const { isStarred } = await c.req.json<{ isStarred?: unknown }>().catch(() => null) || {};
  if (typeof isStarred !== 'boolean') return c.json({ success: false, error: 'isStarred must be true or false' }, 400);

  const result = await c.env.DB.prepare(
    'UPDATE emails SET is_starred = ? WHERE id = ? AND user_id = ?'
  )
    .bind(isStarred ? 1 : 0, emailId, userId)
    .run();

  if (!result.meta?.changes) return c.json({ success: false, error: 'Email not found' }, 404);
  return c.json({ success: true });
});

// ─── Move to Folder ───────────────────────────────────────────────

emails.patch('/:id/move', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('id');
  const pending = await c.env.DB.prepare("SELECT 1 AS found FROM outbound_jobs WHERE email_id = ? AND user_id = ? AND status IN ('queued', 'sending', 'uncertain')")
    .bind(emailId, userId).first();
  if (pending) return c.json({ success: false, error: 'This message has an active or unconfirmed delivery. Resolve delivery before moving or deleting it.' }, 409);

  const { folderId } = await c.req.json<{ folderId?: unknown }>().catch(() => null) || {};
  if (typeof folderId !== 'string' || !folderId) return c.json({ success: false, error: 'A target folder is required' }, 400);

  const folder = await c.env.DB.prepare('SELECT id, type FROM folders WHERE id = ? AND user_id = ?')
    .bind(folderId, userId)
    .first<{ id: string; type: string }>();

  if (!folder) return c.json({ success: false, error: 'Target folder not found' }, 404);

  const result = await moveToFolder(c.env.DB, userId, emailId, folder.id, folder.type);

  if (!result.meta?.changes) return c.json({ success: false, error: 'Email not found' }, 404);
  return c.json({ success: true });
});

// ─── Delete Email ─────────────────────────────────────────────────

emails.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('id');
  const pending = await c.env.DB.prepare("SELECT 1 AS found FROM outbound_jobs WHERE email_id = ? AND user_id = ? AND status IN ('queued', 'sending', 'uncertain')")
    .bind(emailId, userId).first();
  if (pending) return c.json({ success: false, error: 'This message has an active or unconfirmed delivery. Resolve delivery before moving or deleting it.' }, 409);

  const permanent = c.req.query('permanent') === 'true';

  const email = await c.env.DB.prepare(
    'SELECT e.id, e.folder_id, e.r2_body_key, f.type AS folder_type FROM emails e LEFT JOIN folders f ON f.id = e.folder_id WHERE e.id = ? AND e.user_id = ?'
  )
    .bind(emailId, userId)
    .first<{ id: string; folder_id: string; r2_body_key: string; folder_type: string | null }>();

  if (!email) return c.json({ success: false, error: 'Email not found' }, 404);
  // Deleting forever is only offered in Trash. A client acting on a stale view
  // (a just-restored message) must not destroy mail outside it.
  if (permanent && email.folder_type !== 'trash') {
    return c.json({ success: false, error: 'Only messages in Trash can be deleted permanently. Move it to Trash first.' }, 409);
  }

  if (permanent) {
    const attachments = await c.env.DB.prepare(
      'SELECT r2_key FROM attachments WHERE email_id = ?'
    )
      .bind(emailId)
      .all<{ r2_key: string }>();

    // body.txt was previously left behind on every delete, orphaning an object
    // per email forever.
    const keys = [
      email.r2_body_key,
      email.r2_body_key.replace(/body\.html$/, 'protocol.eml'),
      emailBodyTextKey(userId, emailId, email.r2_body_key),
      ...attachments.results.map((a) => a.r2_key),
    ];

    // D1 FIRST, then R2 — the same ordering the retention job documents.
    // Reversed, a failed batch left a readable row in the list whose body and
    // attachments were already gone: the user opens the message and gets an
    // empty pane with dead download links, permanently, because nothing sweeps
    // orphaned emails/ or attachments/ keys. An R2 object orphaned by a failure
    // *after* the D1 commit is merely invisible.
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?').bind(emailId, userId),
      ftsDeleteStatement(c.env.DB, emailId),
    ]);

    await Promise.all(keys.map((key) => c.env.EMAIL_BUCKET.delete(key).catch(() => undefined)));
  } else {
    const trashFolderId = await systemFolderId(c.env.DB, userId, 'trash');
    if (!trashFolderId) return c.json({ success: false, error: 'Trash folder not found' }, 500);

    // Same helper as /move, so a soft delete cannot leave is_archived set and
    // hide the mail from search while it sits in Trash.
    await moveToFolder(c.env.DB, userId, emailId, trashFolderId, 'trash');
  }

  return c.json({ success: true });
});

export { emails as emailRoutes };
