import { repairProtocolNotices } from './protocol-mail';
import { mailboxEnv } from './mailbox-storage';
import type { Env } from '../types';
import { emailBodyTextKey, nowIso } from '../lib/utils';
import { sendViaBinding, type SendParams, type OutboundAttachment } from './email-sender';
import { retainSharedFiles } from './shared-files';

export interface OutboundJob { userId?: string; kind: 'outbound'; emailId: string }
export interface OutboundPayload extends Omit<SendParams, 'html' | 'text' | 'attachments'> {
  bodyKey: string;
  attachments: Omit<OutboundAttachment, 'content'>[];
}
interface Job {
  email_id: string; user_id: string; payload: string; attempts: number;
}

export async function notifyDelivery(env: Env, userId: string): Promise<void> {
  try {
    const hub = env.WEBSOCKET_HUB.get(env.WEBSOCKET_HUB.idFromName(userId));
    await hub.fetch(new Request('https://hub/notify', {
      method: 'POST', body: JSON.stringify({ type: 'delivery_updated', payload: {} }),
    }));
  } catch (error) { console.error('Delivery notification failed', error); }
}

async function setState(env: Env, id: string, status: string, error: string | null, next = nowIso(), messageId?: string) {
  await env.DB.batch([
    env.DB.prepare('UPDATE outbound_jobs SET status = ?, next_attempt_at = ?, updated_at = ? WHERE email_id = ?')
      .bind(status, next, nowIso(), id),
    env.DB.prepare('UPDATE emails SET delivery_status = ?, delivery_error = ?, message_id = COALESCE(?, message_id) WHERE id = ?')
      .bind(status, error, messageId || null, id),
  ]);
}

/** Atomic claim prevents queue redelivery and the recovery cron from sending concurrently. */
export async function processOutbound(job: OutboundJob, env: Env): Promise<void> {
  const owner = job.userId;
  if (!owner) throw new Error('Outbound job is missing mailbox owner');
  env = await mailboxEnv(env, owner);
  const claimed = await env.DB.prepare(
    `UPDATE outbound_jobs SET status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE email_id = ? AND status = 'queued' AND next_attempt_at <= ?
     RETURNING email_id, user_id, payload, attempts`
  ).bind(nowIso(), job.emailId, nowIso()).first<Job>();
  if (!claimed) return;

  await env.DB.prepare("UPDATE emails SET delivery_status = 'sending' WHERE id = ?").bind(job.emailId).run();
  let params: SendParams;
  try {
    const payload = JSON.parse(claimed.payload) as OutboundPayload;
    const [html, text] = await Promise.all([
      env.EMAIL_BUCKET.get(payload.bodyKey),
      env.EMAIL_BUCKET.get(emailBodyTextKey(claimed.user_id, job.emailId, payload.bodyKey)),
    ]);
    if (!html || !text) throw new Error('Stored message body is missing');
    const attachments: OutboundAttachment[] = [];
    for (const attachment of payload.attachments) {
      const object = await env.EMAIL_BUCKET.get(attachment.r2Key);
      if (!object) throw new Error('Stored attachment is missing');
      attachments.push({ ...attachment, content: await object.arrayBuffer() });
    }
    params = { ...payload, html: await html.text(), text: await text.text(), attachments };
    // Strict, before the provider call: the post-commit retain in /send is
    // best-effort, and a delivered link must never point at a purgeable file.
    await retainSharedFiles(env, params.html, params.text, true);
  } catch (error) {
    // No provider call was made: retrying is safe.
    await setState(env, job.emailId, claimed.attempts >= 72 ? 'failed' : 'queued',
      claimed.attempts >= 72 ? 'Unable to read the saved message. Automatic retries have stopped.' : 'Unable to read the saved message. Retrying.', new Date(Date.now() + 60_000).toISOString());
    await notifyDelivery(env, claimed.user_id);
    return;
  }

  let messageId: string | undefined;
  try {
    messageId = await sendViaBinding(env, params);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    // Keep the underlying binding failure visible to operators. Never log the
    // payload, credentials, message body, or attachments.
    const diagnostic = (error instanceof Error ? error.message : 'Non-Error thrown by email sender')
      .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, '[email]')
      .replace(/mp_[a-f0-9]{64}/gi, '[device-password]')
      .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 500);
    console.error('Outbound sending call failed', {
      emailId: job.emailId, attempt: claimed.attempts,
      code: /^E_[A-Z0-9_]+$/.test(code) ? code : 'UNCLASSIFIED',
      message: diagnostic,
    });
    const retryable = ['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR'].includes(code);
    const knownRejection = retryable || ['E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS', 'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED', 'E_RECIPIENT_SUPPRESSED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY'].includes(code);
    const status = retryable && claimed.attempts < 72 ? 'queued' : knownRejection ? 'failed' : 'uncertain';
    const delay = code === 'E_DAILY_LIMIT_EXCEEDED' ? 3600 : Math.min(3600, 30 * 2 ** Math.min(claimed.attempts, 7));
    await setState(env, job.emailId, status,
      status === 'uncertain' ? 'Delivery could not be confirmed. Check with the recipient before sending again.' :
        (error instanceof Error ? error.message : 'Sending failed'),
      new Date(Date.now() + delay * 1000).toISOString());
    await notifyDelivery(env, claimed.user_id);
    return;
  }

  // If this commit fails after provider acceptance, leave the claim in place.
  // Recovery flags it for review instead of automatically duplicating the email.
  await setState(env, job.emailId, 'sent', null, nowIso(), messageId);
  await notifyDelivery(env, claimed.user_id);
}

/** Repairs missed queue publications; the database is the durable source of truth. */
export async function dispatchOutbox(env: Env): Promise<void> {
  if (!env.MAILBOX_USER_ID) throw new Error('Outbox dispatch requires a mailbox');
  try { await repairProtocolNotices(env,env.MAILBOX_USER_ID); } catch { console.error('Protocol delivery notices will retry'); }
  const cutoff = new Date(Date.now() - 20 * 60_000).toISOString();
  const stale = await env.DB.prepare(`SELECT email_id, user_id FROM outbound_jobs WHERE status = 'sending' AND updated_at < ? LIMIT 100`)
    .bind(cutoff).all<{ email_id: string; user_id: string }>();
  for (const job of stale.results) {
    await setState(env, job.email_id, 'uncertain', 'Sending was interrupted. Check delivery before resending.');
    await notifyDelivery(env, job.user_id);
  }
  const due = await env.DB.prepare(`SELECT email_id, user_id FROM outbound_jobs WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 100`)
    .bind(nowIso()).all<{ email_id: string; user_id: string }>();
  if (due.results.length) await env.OUTBOUND_QUEUE.sendBatch(due.results.map(row => ({ body: { kind: 'outbound' as const, emailId: row.email_id, userId: row.user_id } })));
}
