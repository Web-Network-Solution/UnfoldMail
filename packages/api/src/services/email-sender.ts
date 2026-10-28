/**
 * Outbound email helpers: attachment materialization from R2, signatures,
 * and the `send_email` binding call with recipient checks. The Sent copy and
 * outbox job are written by routes/emails.ts; outbox.ts and forwarding.ts deliver.
 */
import type { Env, SendEmailAddress, SendEmailAttachment, SendEmailMessage } from '../types';
import { MAX_OUTBOUND_MESSAGE_SIZE, MAX_RECIPIENTS, encodedMessageBytes } from '@email-service/shared';
import { attachmentKey, generateUUIDv7, sanitizeFilename } from '../lib/utils';

export interface OutboundAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Final R2 key, under attachments/. */
  r2Key: string;
  contentId?: string;
  disposition: 'inline' | 'attachment';
  content: ArrayBuffer;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 502 = 502,
    readonly code?: string
  ) {
    super(message);
    this.name = 'SendError';
  }
}

/**
 * MIME encodes attachment bytes as base64 (4 bytes out per 3 in) plus part
 * headers, so the on-the-wire size is meaningfully larger than the raw total.
 * Checking raw bytes against the 5 MiB ceiling let messages through that
 * Cloudflare then rejected.
 */
export function encodedSize(rawBytes: number): number {
  return encodedMessageBytes(rawBytes);
}

/** Rough per-part MIME header overhead (Content-Type, Disposition, boundary). */
const PART_OVERHEAD_BYTES = 200;

/**
 * Pull staged uploads and carried-over attachments out of R2 and copy them to
 * their permanent per-email location.
 *
 * `uploadKeys`  — keys from POST /attachments/upload (under uploads/).
 * `carriedIds`  — attachment IDs on an existing email owned by this user
 *                 (forwarding, or re-saving a draft).
 *
 * `bodyBytes` is the encoded size of the message body, so the size ceiling is
 * checked against the whole message rather than the attachments alone.
 */
export async function materializeAttachments(
  env: Env,
  userId: string,
  emailId: string,
  uploadKeys: string[],
  carriedIds: string[],
  bodyBytes = 0
): Promise<OutboundAttachment[]> {
  if (uploadKeys.length + carriedIds.length > 32) throw new SendError('At most 32 attachments are allowed', 400);
  const out: OutboundAttachment[] = [];
  let total = bodyBytes;

  // Everything this function writes, so a mid-loop failure can undo its own
  // copies instead of orphaning them in R2 forever.
  const written: string[] = [];

  const add = async (source: {
    filename: string;
    mimeType: string;
    r2Key: string;
    contentId?: string;
    disposition?: 'inline' | 'attachment';
  }): Promise<void> => {
    const object = await env.EMAIL_BUCKET.get(source.r2Key);
    if (!object) throw new SendError(`Attachment no longer available: ${source.filename}`, 400);

    const content = await object.arrayBuffer();
    total += encodedSize(content.byteLength) + PART_OVERHEAD_BYTES;

    if (total > MAX_OUTBOUND_MESSAGE_SIZE) {
      throw new SendError(
        `Message exceeds the ${MAX_OUTBOUND_MESSAGE_SIZE / (1024 * 1024)} MB limit once encoded`,
        413
      );
    }

    const id = generateUUIDv7();
    const destKey = attachmentKey(userId, emailId, id, source.filename);
    await env.EMAIL_BUCKET.put(destKey, content, {
      httpMetadata: { contentType: source.mimeType },
      customMetadata: { originalFilename: source.filename },
    });
    written.push(destKey);

    out.push({
      id,
      filename: source.filename,
      mimeType: source.mimeType,
      size: content.byteLength,
      r2Key: destKey,
      contentId: source.contentId,
      disposition: source.disposition || 'attachment',
      content,
    });
  };

  try {
    // Staged compose uploads. The key must belong to this user — otherwise one
    // employee could attach another employee's staged file by guessing a key.
    for (const key of uploadKeys) {
      if (!key.startsWith(`uploads/${userId}/`)) {
        throw new SendError('Invalid attachment reference', 400);
      }
      const head = await env.EMAIL_BUCKET.head(key);
      if (!head) throw new SendError('Attachment upload expired, please re-attach', 400);

      await add({
        filename:
          head.customMetadata?.originalFilename ||
          sanitizeFilename(key.split('/').pop() || 'attachment'),
        mimeType: head.httpMetadata?.contentType || 'application/octet-stream',
        r2Key: key,
      });
    }

    // Attachments carried over from a forwarded message or an existing draft.
    for (const attachmentId of carriedIds) {
      const row = await env.DB.prepare(
        `SELECT a.filename, a.mime_type, a.r2_key, a.content_id, a.disposition
         FROM attachments a
         JOIN emails e ON e.id = a.email_id
         WHERE a.id = ? AND e.user_id = ?`
      )
        .bind(attachmentId, userId)
        .first<{
          filename: string;
          mime_type: string;
          r2_key: string;
          content_id: string | null;
          disposition: string | null;
        }>();

      if (!row) throw new SendError('Attachment not found', 400);

      await add({
        filename: row.filename,
        mimeType: row.mime_type,
        r2Key: row.r2_key,
        contentId: row.content_id || undefined,
        disposition: row.disposition === 'inline' ? 'inline' : 'attachment',
      });
    }
  } catch (err) {
    await Promise.all(written.map((key) => env.EMAIL_BUCKET.delete(key).catch(() => undefined)));
    throw err;
  }

  // NOTE: the staged uploads/ objects are deliberately NOT deleted here.
  // This runs before the send, and dropping the user's originals at this point
  // means a failed send leaves them with nothing to retry from. The caller
  // releases them with releaseStagedUploads() once the message is committed.
  return out;
}

/**
 * Drop staged compose uploads once the message they belong to is safely sent
 * and persisted. Best-effort: anything missed is swept by the retention job.
 */
export async function releaseStagedUploads(env: Env, uploadKeys: string[]): Promise<void> {
  await Promise.all(uploadKeys.map((key) => env.EMAIL_BUCKET.delete(key).catch(() => undefined)));
}

/** Append the user's signature to an HTML body. */
export function withSignature(html: string, signatureHtml: string): string {
  if (!signatureHtml) return html;
  // The frontend compose editor now embeds the signature with this marker.
  // Skip appending a second copy when the user already edited it inline.
  if (html.includes('data-signature="true"')) return html;
  return `${html}<br/><div class="email-signature">${signatureHtml}</div>`;
}

/**
 * Plain-text counterpart, so the text/plain part is not missing the signature.
 * When the HTML already carries the editor's signature, the client's text does too.
 */
export function withSignatureText(text: string, signatureHtml: string, html = ''): string {
  if (!signatureHtml || html.includes('data-signature="true"')) return text;
  const plain = signatureHtml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return plain ? `${text}\n\n--\n${plain}` : text;
}

export interface SendParams {
  from: SendEmailAddress;
  to: SendEmailAddress[];
  cc: SendEmailAddress[];
  bcc: SendEmailAddress[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments: OutboundAttachment[];
}

/**
 * Hand the message to Cloudflare Email Sending.
 *
 * Note on Message-ID: the binding assigns it. We do NOT try to force one via
 * the headers map — `Message-ID` is not on Cloudflare's accepted-header
 * allowlist, so setting it was silently dropped while the value we stored in
 * D1 diverged from the one recipients actually saw, quietly breaking reply
 * threading. The ID returned by `send()` is authoritative.
 */
export async function sendViaBinding(env: Env, params: SendParams): Promise<string | undefined> {
  const recipientCount = params.to.length + params.cc.length + params.bcc.length;

  if (recipientCount === 0) throw new SendError('At least one recipient is required', 400);
  if (recipientCount > MAX_RECIPIENTS) {
    throw new SendError(`Cloudflare Email Sending allows at most ${MAX_RECIPIENTS} recipients`, 400);
  }

  const headers: Record<string, string> = { ...params.headers };
  if (params.inReplyTo) headers['In-Reply-To'] = params.inReplyTo;
  if (params.references) headers['References'] = params.references;

  // The live binding requires a string name on object-form addresses, even
  // though its public interface marks name optional. MIME imports commonly
  // omit it. Normalize every address at the provider boundary.
  const address = (value: SendEmailAddress): SendEmailAddress => ({
    email: value.email,
    name: typeof value.name === 'string' ? value.name : '',
  });

  const message: SendEmailMessage = {
    from: address(params.from),
    to: params.to.map(address),
    subject: params.subject || '(no subject)',
    html: params.html,
    text: params.text,
  };

  if (params.cc.length) message.cc = params.cc.map(address);
  if (params.bcc.length) message.bcc = params.bcc.map(address);
  if (params.replyTo) message.replyTo = params.replyTo;
  if (Object.keys(headers).length) message.headers = headers;

  if (params.attachments.length) {
    message.attachments = params.attachments.map((att): SendEmailAttachment => {
      const part: SendEmailAttachment = {
        content: att.content,
        filename: att.filename,
        type: att.mimeType,
        disposition: att.disposition,
      };
      // An inline part needs its Content-ID preserved or the cid: reference in
      // the forwarded body resolves to nothing.
      if (att.disposition === 'inline' && att.contentId) part.contentId = att.contentId;
      return part;
    });
  }

  try {
    const response = await env.SEND_EMAIL.send(message);
    return response && typeof response === 'object' ? response.messageId : undefined;
  } catch (err) {
    // Surface the real reason (unverified domain, rate limit, bad recipient)
    // rather than reporting success for mail that never left.
    throw new SendError(err instanceof Error ? err.message : 'Email delivery failed', 502,
      err && typeof err === 'object' && 'code' in err ? String(err.code) : undefined);
  }
}
