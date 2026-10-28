import { mailboxEnv } from './mailbox-storage';
import type { Database } from "../services/mailbox-storage";
/**
 * Email Processor Service
 *
 * Queue consumer: reads the staged raw MIME from R2, parses it, stores the
 * body and attachments in R2, commits the metadata, FTS row, dedupe claim and
 * filter/forwarding rows in one transaction in the recipient's MailboxDO, and
 * notifies the recipient's WebSocket hub.
 */
import PostalMime from 'postal-mime';
import type { Env, InboundEmailMessage } from '../types';
import {
  generateUUIDv7,
  emailBodyKey,
  emailBodyTextKey,
  attachmentKey,
  extractSnippet,
  nowIso,
  toIso,
} from '../lib/utils';
import { ftsInsertStatement } from '../lib/fts';
import { sanitizeEmailHtml } from '../lib/sanitize-html';
import { prepareForwarding } from './forwarding';
import { blocksAutomaticForwarding, htmlText } from './mail-filters';
import { applyEmailedReply } from './calendar';

interface ParsedAddress {
  address: string;
  name?: string;
}

interface ParsedAttachment {
  filename: string;
  mimeType: string;
  content: ArrayBuffer;
  /** Content-ID without angle brackets, for cid: references in the HTML body. */
  contentId?: string;
  disposition: 'inline' | 'attachment';
}

interface ParsedEmail {
  blockForwarding: boolean;
  replyTo?: string;
  from: ParsedAddress;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  subject: string;
  html: string;
  text: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  attachments: ParsedAttachment[];
}

/**
 * postal-mime address fields are `Address | Address[] | null`, and an `Address`
 * is either a mailbox (`{name, address}`) or a *group* (`{name, group: [...]}`)
 * with no `address` at all. Reading `.address` blindly is why a header like
 * `To: undisclosed-recipients:;` crashed the consumer into the DLQ.
 */
function flattenAddresses(input: unknown): ParsedAddress[] {
  const out: ParsedAddress[] = [];

  const visit = (entry: unknown) => {
    if (!entry || typeof entry !== 'object') return;
    const node = entry as { address?: unknown; name?: unknown; group?: unknown };

    if (Array.isArray(node.group)) {
      for (const member of node.group) visit(member);
      return;
    }
    if (typeof node.address === 'string' && node.address.includes('@')) {
      out.push({
        address: node.address.trim().toLowerCase(),
        name: typeof node.name === 'string' && node.name.trim() ? node.name.trim() : undefined,
      });
    }
  };

  if (Array.isArray(input)) input.forEach(visit);
  else visit(input);

  return out;
}

/** postal-mime gives attachment content as ArrayBuffer or string, depending on encoding. */
function toArrayBuffer(content: unknown): ArrayBuffer {
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).buffer as ArrayBuffer;
  }
  return new ArrayBuffer(0);
}

/**
 * Is this MIME part an embedded part of the body, or a file the user attached?
 *
 * Getting this wrong is not cosmetic in either direction: classify a real
 * attachment as inline and it vanishes from the UI completely — no paperclip,
 * no chip, no download link — while its bytes sit in R2, so the user believes
 * the file was never sent.
 *
 * The rules, in priority order:
 *  1. An EXPLICIT `Content-Disposition` wins. A part marked `attachment` is an
 *     attachment even inside multipart/related and even with a Content-ID —
 *     this is exactly the case that made PDFs disappear.
 *  2. With no explicit disposition, treat it as inline only when everything
 *     points that way: postal-mime flagged it `related` (a Content-ID part in a
 *     multipart/related container), it actually has a Content-ID to reference,
 *     and it is an image. A `cid:`-referenced PDF is still a download.
 *  3. Otherwise it is an attachment.
 */
export function classifyDisposition(
  raw: string | null | undefined,
  related: boolean,
  contentId: string,
  mimeType: string
): 'inline' | 'attachment' {
  if (raw === 'attachment') return 'attachment';
  if (raw === 'inline') return 'inline';
  if (related && contentId && /^image\//i.test(mimeType)) return 'inline';
  return 'attachment';
}

async function parseMimeEmail(raw: ArrayBuffer, envelopeSender: string): Promise<ParsedEmail> {
  const parsed = await new PostalMime().parse(raw);

  const from = flattenAddresses(parsed.from)[0] || { address: 'unknown@invalid' };

  return {
    blockForwarding: blocksAutomaticForwarding(parsed.headers, envelopeSender),
    from,
    replyTo: flattenAddresses(parsed.replyTo)[0]?.address,
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    bcc: flattenAddresses(parsed.bcc),
    subject: parsed.subject || '(no subject)',
    html: parsed.html || '',
    text: parsed.text || '',
    messageId: parsed.messageId || undefined,
    inReplyTo: parsed.inReplyTo || undefined,
    references: parsed.references || undefined,
    attachments: (parsed.attachments || []).map((att) => {
      const rawId = typeof att.contentId === 'string' ? att.contentId.replace(/^<|>$/g, '') : '';
      const related = (att as { related?: boolean }).related === true;

      const mimeType = att.mimeType || 'application/octet-stream';

      return {
        filename: att.filename || 'unnamed',
        mimeType,
        content: toArrayBuffer(att.content),
        contentId: rawId || undefined,
        disposition: classifyDisposition(att.disposition, related, rawId, mimeType),
      };
    }),
  };
}

/**
 * Largest inline part that gets embedded into the body as a data: URI.
 * Real logos and signature images are a few KB; anything bigger is almost
 * certainly a mis-labelled attachment and is left as a normal one.
 */
const MAX_INLINE_EMBED_BYTES = 512 * 1024;

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on
  // anything non-trivial. 8 KB per spread — the common 32 KB idiom sits close
  // enough to the engine's argument limit to risk a RangeError under stack
  // pressure, and this runs inside a Worker.
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Replace `cid:` references with self-contained data: URIs.
 *
 * Inline images arrive as separate MIME parts referenced by Content-ID; stored
 * verbatim, every embedded image renders broken.
 *
 * They are embedded rather than pointed at `/api/attachments/:id/download`,
 * because the body is rendered in a sandboxed iframe WITHOUT
 * `allow-same-origin`. That frame has an opaque origin, so a subresource
 * request from it carries no session cookie and the download endpoint answers
 * 401 — a URL rewrite would look correct and still show a broken image.
 */
/**
 * Only these become data: URIs. The MIME type is interpolated straight into
 * the document, and the value is sender-controlled — an allowlist is what stops
 * `Content-Type: x/y><script>…` from closing the attribute and injecting live
 * markup past the sanitizer. SVG is excluded deliberately: it can carry script.
 */
const EMBEDDABLE_IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp|bmp|x-icon)$/i;

/** Total data: URI budget per message, so a body cannot be inflated without bound. */
const MAX_TOTAL_EMBED_BYTES = 2 * 1024 * 1024;

/**
 * A `cid:` token: the same terminator set as cidPattern, so the greedy run ends
 * exactly where cidPattern's lookahead would — cid:img1 never matches cid:img10.
 */
const CID_TOKEN = /cid:([^"')\s>&]+)/gi;

/** Adds every part it actually embedded to `embedded`; only those stay inline. */
export function embedInlineImages(html: string, attachments: ParsedAttachment[], embedded: Set<ParsedAttachment>): string {
  if (!html) return html;

  // One scan of the body, not one per part: a crafted message with thousands of
  // tiny inline parts would otherwise cost parts x body length of CPU.
  const counts = new Map<string, number>();
  for (const m of html.matchAll(CID_TOKEN)) { const id = m[1].toLowerCase(); counts.set(id, (counts.get(id) || 0) + 1); }

  const uris = new Map<string, string>();
  let budget = MAX_TOTAL_EMBED_BYTES;

  for (const att of attachments) {
    if (!att.contentId || att.disposition !== 'inline') continue;
    if (att.content.byteLength > MAX_INLINE_EMBED_BYTES) continue;
    if (!EMBEDDABLE_IMAGE_TYPES.test(att.mimeType)) continue;

    // ponytail: a Content-ID containing a token terminator (' & or whitespace — legal
    // but unseen in practice) never matches, so that part is kept as a visible attachment.
    const id = att.contentId.toLowerCase();
    if (uris.has(id)) continue;

    // Every occurrence gets its own full base64 copy, so the cost is
    // occurrences x payload. A body repeating `cid:x` a thousand times would
    // otherwise inflate a 400 KB image into a 500 MB document.
    const occurrences = counts.get(id) || 0;
    if (occurrences === 0) continue;

    const encodedCost = Math.ceil(att.content.byteLength / 3) * 4 * occurrences;
    if (encodedCost > budget) continue;
    budget -= encodedCost;

    uris.set(id, `data:${att.mimeType.toLowerCase()};base64,${toBase64(att.content)}`);
    embedded.add(att);
  }
  if (!uris.size) return html;

  // Replacement is a FUNCTION, not a string: as a string, `$&` / `$1` inside
  // the base64 payload would be interpreted as substitution patterns.
  return html.replace(CID_TOKEN, (token, id: string) => uris.get(id.toLowerCase()) ?? token);
}

/**
 * Resolve the thread for a message, scoped to the recipient's own mailbox.
 * An unscoped lookup could attach this email to a thread in someone else's
 * mailbox, leaking the thread grouping across users.
 */
async function resolveThreadId(
  db: Database,
  userId: string,
  inReplyTo?: string,
  references?: string
): Promise<string> {
  const candidates = [
    ...(inReplyTo ? [inReplyTo] : []),
    ...(references ? references.split(/\s+/).filter(Boolean).reverse() : []),
  ].slice(0, 20);

  for (const messageId of candidates) {
    const row = await db
      .prepare('SELECT thread_id FROM emails WHERE message_id = ? AND user_id = ? LIMIT 1')
      .bind(messageId, userId)
      .first<{ thread_id: string }>();
    if (row) return row.thread_id;
  }

  return generateUUIDv7();
}

/**
 * Resolve the mailbox this delivery belongs to.
 *
 * Uses the SMTP envelope recipient, not the To/Cc headers. Email Routing
 * invokes the Worker once per envelope recipient, so:
 *  - Bcc'd employees get their copy (they appear in no header at all), and
 *  - a message addressed to five colleagues is not duplicated five times in
 *    every one of their mailboxes.
 */
async function resolveMailbox(env: Env, envelopeTo: string): Promise<{userId:string;email:string;inboxFolderId:string}|null> {
  const user = await env.DB.prepare('SELECT id,email FROM users WHERE email=?').bind(envelopeTo.trim().toLowerCase()).first<{id:string;email:string}>();
  if (!user) return null;
  const scoped = await mailboxEnv(env,user.id);
  const folder = await scoped.DB.prepare("SELECT id FROM folders WHERE user_id=? AND type='inbox'").bind(user.id).first<{id:string}>();
  return folder ? {userId:user.id,email:user.email,inboxFolderId:folder.id} : null;
}

/**
 * The email id that committed this (messageKey, userId) delivery, or null.
 *
 * This is only a read. The claim itself is written inside the same MailboxDO
 * transaction as the email row, so a delivery is marked processed if and only
 * if its data actually landed. Claiming up front instead would lose the
 * message: a failure during parsing or storage would retry, find the claim
 * already present, and skip the message forever.
 */
async function processedEmailId(
  db: Database,
  messageKey: string,
  userId: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT email_id FROM processed_inbound WHERE message_key = ? AND user_id = ?')
    .bind(messageKey, userId)
    .first<{ email_id: string }>();
  return row ? row.email_id : null;
}

/**
 * Process a single inbound email message from the Queue.
 */
export async function processInboundEmail(message: InboundEmailMessage, env: Env): Promise<void> {
  const staged = await env.EMAIL_BUCKET.get(message.rawKey);

  if (!staged) {
    // Already processed and cleaned up, or the object expired. Nothing to do —
    // throwing here would retry forever against an object that will never exist.
    console.warn(`Staged inbound object missing, skipping: ${message.rawKey}`);
    return;
  }

  const mailbox = await resolveMailbox(env, message.to);

  if (!mailbox) {
    // No user owns this address. Return (ack) so the queue does not retry
    // forever, but KEEP the staged raw message: deleting it immediately
    // destroyed the only copy of mail that may have been misrouted rather than
    // genuinely unknown. The retention sweep reclaims it after 7 days, and
    // only because no account owns the envelope recipient: staged mail for an
    // existing account is never swept.
    console.warn(
      `No mailbox for envelope recipient "${message.to}" — retaining ${message.rawKey} for inspection`
    );
    return;
  }

  env = await mailboxEnv(env, mailbox.userId);

  // Keyed on the RFC Message-ID, which survives an Email Routing redelivery
  // (each attempt stages a different R2 object, so the staging key
  // deduplicated nothing). Falls back to a SHA-256 of the raw bytes when the
  // sender omits the header: an identical redelivery hashes the same.
  //
  // Scoped by the ENVELOPE SENDER. Message-ID is attacker-chosen text: keyed
  // on it alone, anyone could pre-send a message carrying the Message-ID a
  // known correspondent was about to use and have the real one silently
  // discarded as a duplicate. Scoping means a sender can only ever suppress
  // their own mail.
  const raw = await staged.arrayBuffer();
  const messageKey = message.messageKey ||
    'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const dedupeKey = `${(message.from || '').toLowerCase()}|${messageKey}`;

  if (await processedEmailId(env.DB, dedupeKey, mailbox.userId)) {
    console.log(`Duplicate delivery ignored: ${dedupeKey} → ${mailbox.email}`);
    await env.EMAIL_BUCKET.delete(message.rawKey);
    return;
  }

  const emailId = generateUUIDv7();
  const parsed = await parseMimeEmail(raw, message.from);
  const receivedAt = toIso(message.receivedAt);
  // One pass over a possibly hostile body serves both the snippet and the filters.
  const filterText = parsed.text || htmlText(parsed.html);
  const snippet = extractSnippet(filterText);
  const bodyKey = emailBodyKey(mailbox.userId, emailId);
  const bodyTextKey = emailBodyTextKey(mailbox.userId, emailId);

  // Sanitized BEFORE embedding, so a hostile body cannot smuggle markup in
  // around the data: URIs inserted after it.
  const embedded = new Set<ParsedAttachment>();
  const html = embedInlineImages(sanitizeEmailHtml(parsed.html), parsed.attachments, embedded);

  // Only a part actually embedded above stays inline. The UI hides inline
  // parts and has_attachments ignores them, so an inline PDF, an SVG, or an
  // oversized or unreferenced image would otherwise never be seen. The
  // forwarding snapshot keeps the original MIME classification (parsed.attachments)
  // so a still-cid-referenced part keeps its Content-ID in the forwarded copy.
  const attachmentRecords = parsed.attachments.map((att) => {
    const id = generateUUIDv7();
    return {
      id,
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.content.byteLength,
      r2Key: attachmentKey(mailbox.userId, emailId, id, att.filename),
      contentId: att.contentId,
      disposition: embedded.has(att) ? 'inline' : 'attachment',
      content: att.content,
    };
  });

  // Only real HTML goes to the .html key. Writing the plain-text body there and
  // labelling it text/html made every plain-text email render with its
  // newlines collapsed and any stray angle brackets eaten as markup.
  const storedHtml = parsed.html ? html : '';
  const forwarding = await prepareForwarding(env, {
    emailId, userId: mailbox.userId, userEmail: mailbox.email, inboxFolderId: mailbox.inboxFolderId,
    message: { from: parsed.from.address, to: [...parsed.to, ...parsed.cc].map(a => a.address).concat(message.to),
      subject: parsed.subject, text: filterText,
      hasAttachments: attachmentRecords.some(a => a.disposition !== 'inline'), size: message.rawSize || staged.size || 0 },
    html: storedHtml, text: parsed.text, replyTo: parsed.replyTo, blockForwarding: parsed.blockForwarding,
    attachments: parsed.attachments,
  });

  // Every key this invocation may have written. Known up front rather than
  // recorded as each put resolves: Promise.all rejects on the FIRST failure
  // while its siblings are still in flight, so a "written keys" list populated
  // from .then() callbacks systematically misses the puts that landed after the
  // rejection — and those leaked permanently on every retry. Deleting a key
  // that was never written is a harmless no-op, so the full list is the safe
  // thing to roll back.
  const allR2Keys = [bodyKey, bodyTextKey, ...attachmentRecords.map((a) => a.r2Key), ...forwarding.keys];

  const rollbackR2 = async () => {
    await Promise.all(allR2Keys.map((key) => env.EMAIL_BUCKET.delete(key).catch(() => undefined)));
  };

  // allSettled, so every put finishes before the rollback runs. Rolling back
  // while writes are still outstanding would delete objects that then get
  // re-created by the in-flight put.
  const writes = await Promise.allSettled([
    env.EMAIL_BUCKET.put(bodyKey, storedHtml, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    }),
    env.EMAIL_BUCKET.put(bodyTextKey, parsed.text || '', {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    }),
    ...attachmentRecords.map((att) =>
      env.EMAIL_BUCKET.put(att.r2Key, att.content, {
        httpMetadata: { contentType: att.mimeType },
        customMetadata: { originalFilename: att.filename },
      })
    ),
  ]);

  const failed = writes.find((w): w is PromiseRejectedResult => w.status === 'rejected');
  if (failed) {
    await rollbackR2();
    throw failed.reason instanceof Error
      ? failed.reason
      : new Error(`R2 write failed for ${message.rawKey}: ${String(failed.reason)}`);
  }

  const threadId = await resolveThreadId(
    env.DB,
    mailbox.userId,
    parsed.inReplyTo,
    parsed.references
  );

  // A paperclip should mean "there is a file here", not "this message contains
  // an embedded logo".
  const realAttachments = attachmentRecords.filter((a) => a.disposition !== 'inline');

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO emails (id, thread_id, folder_id, user_id, sender, sender_name,
        recipients_to, recipients_cc, recipients_bcc, subject, snippet, r2_body_key,
        is_read, has_attachments, size, message_id, in_reply_to, references_chain, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
    ).bind(
      emailId,
      threadId,
      mailbox.inboxFolderId,
      mailbox.userId,
      parsed.from.address,
      parsed.from.name || '',
      JSON.stringify(parsed.to.map((t) => ({ email: t.address, name: t.name }))),
      JSON.stringify(parsed.cc.map((t) => ({ email: t.address, name: t.name }))),
      JSON.stringify(parsed.bcc.map((t) => ({ email: t.address, name: t.name }))),
      parsed.subject,
      snippet,
      bodyKey,
      realAttachments.length > 0 ? 1 : 0,
      message.rawSize || staged.size || 0,
      parsed.messageId || null,
      parsed.inReplyTo || null,
      parsed.references || null,
      receivedAt
    ),
    ...attachmentRecords.map((att) =>
      env.DB.prepare(
        `INSERT INTO attachments (id, email_id, filename, mime_type, size, r2_key, created_at, content_id, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        att.id,
        emailId,
        att.filename,
        att.mimeType,
        att.size,
        att.r2Key,
        receivedAt,
        att.contentId || null,
        att.disposition
      )
    ),
    ftsInsertStatement(env.DB, {
      emailId,
      userId: mailbox.userId,
      subject: parsed.subject,
      sender: parsed.from.address,
      snippet,
    }),
    // The idempotency claim is committed with the data, not before it. A plain
    // INSERT (no ON CONFLICT): if a concurrent delivery of the same message
    // already claimed it, this violates the primary key, the whole batch rolls
    // back, and the retry sees it as processed instead of writing a duplicate.
    env.DB.prepare(
      `INSERT INTO processed_inbound (message_key, user_id, email_id, processed_at)
       VALUES (?, ?, ?, ?)`
    ).bind(dedupeKey, mailbox.userId, emailId, nowIso()),
    ...forwarding.statements,
    ...(env.AI_ASSISTANTS ? [env.DB.prepare('INSERT OR IGNORE INTO ai_candidates(id,sender,subject,automated,created) VALUES(?,?,?,?,?)').bind(emailId,parsed.from.address,parsed.subject,message.automated?1:0,Date.now())] : []),
  ];

  // The recipient's MailboxDO runs the batch as a single transaction, so a
  // failure anywhere above leaves nothing committed and the queue retry starts
  // from a clean slate.
  try {
    await env.DB.batch(statements);
  } catch (err) {
    // A rejection is not proof of rollback — the transaction can commit and the
    // response still fail in transit. Deleting unconditionally would then erase
    // the body and attachments of a message that IS in the inbox, leaving a
    // readable row pointing at nothing.
    //
    // So confirm the claim is not THIS attempt's before cleaning up. A claim
    // from a concurrent delivery that won the race points at its own emailId
    // and its own R2 keys; these ones are ours and would leak forever. If the
    // check itself fails, leak the objects: a leaked object costs storage, a
    // wrongly deleted one costs the user their mail.
    let committed = true;
    try {
      committed = (await processedEmailId(env.DB, dedupeKey, mailbox.userId)) === emailId;
    } catch {
      committed = true;
    }

    if (!committed) {
      await rollbackR2();
    } else {
      console.warn(
        `Batch reported failure but this delivery's claim is present for ${dedupeKey}; keeping R2 objects.`
      );
    }
    throw err;
  }

  // ponytail: the staged raw MIME is dropped once parsed. Keep it (and add a
  // lifecycle rule) if you ever need lossless replay or forensics.
  await env.EMAIL_BUCKET.delete(message.rawKey);
  if (forwarding.jobs.length) {
    try { await env.OUTBOUND_QUEUE.sendBatch(forwarding.jobs.map(body => ({ body }))); }
    catch (error) { console.error('Forwarding publication deferred to the mailbox alarm', error); }
  }

  // An emailed RSVP (iTIP REPLY) to one of the recipient's events. The mail is already committed and
  // delivered either way, so this never throws: a failure must not retry or duplicate the delivery.
  // Mail that may not be auto-forwarded (our own forwards, auto-replies, bounces) is not the sender's own RSVP.
  const calendarPart = parsed.attachments.find((a) => /^text\/calendar$/i.test(a.mimeType) && a.content.byteLength <= 100 * 1024);
  if (calendarPart && !parsed.blockForwarding) {
    try { await applyEmailedReply(env, mailbox.userId, message.from || '', new TextDecoder().decode(calendarPart.content)); }
    catch (error) { console.error('Emailed calendar reply was not applied', error); }
  }

  // Notify the recipient's WebSocket hub. Best-effort: the user may be offline.
  try {
    const doStub = env.WEBSOCKET_HUB.get(env.WEBSOCKET_HUB.idFromName(mailbox.userId));
    await doStub.fetch('https://internal/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'new_email',
        payload: {
          emailId,
          threadId,
          sender: parsed.from.address,
          senderName: parsed.from.name,
          subject: parsed.subject,
          snippet,
          folderId: forwarding.folderId,
          receivedAt,
          hasAttachments: realAttachments.length > 0,
        },
      }),
    });
  } catch (err) {
    console.error(`WebSocket notification failed for user ${mailbox.userId}:`, err);
  }
}
