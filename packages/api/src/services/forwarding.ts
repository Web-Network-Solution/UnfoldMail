import { mailboxEnv, centralDB } from './mailbox-storage';
import { MAX_OUTBOUND_MESSAGE_SIZE, encodedMessageBytes } from '@email-service/shared';
import type { Env } from '../types';
import { generateUUIDv7, nowIso, isValidEmail } from '../lib/utils';
import { sendViaBinding, type OutboundAttachment, type SendParams } from './email-sender';
import { destinationAllowed, evaluateFilters, getForwardingConfig, getForwardingPolicy, type FilterMessage } from './mail-filters';

export interface ForwardingQueueJob { userId?: string; kind: 'forwarding'; id: string }
interface Snapshot extends Omit<SendParams, 'attachments'> {
  attachments: { filename: string; mimeType: string; size: number; r2Key: string; contentId?: string; disposition: 'inline' | 'attachment'; shareId: string }[];
}
interface ForwardingInput {
  emailId: string; userId: string; userEmail: string; inboxFolderId: string;
  message: FilterMessage; html: string; text: string; replyTo?: string;
  blockForwarding: boolean;
  attachments: { filename: string; mimeType: string; content: ArrayBuffer; contentId?: string; disposition: 'inline' | 'attachment' }[];
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
/** Exact `cid:` token: the sender-controlled id is escaped, and cid:img1 must not match the prefix of cid:img10. `&` ends it as in `url(&quot;cid:x&quot;)`. */
export const cidPattern = (contentId: string) => new RegExp(`cid:${contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["')\\s>&]|$)`, 'gi');

/** R2 snapshots finish before the caller atomically commits mail, rules and jobs. */
export async function prepareForwarding(env: Env, input: ForwardingInput) {
  const config = await getForwardingConfig(env.DB, input.userId);
  const result = evaluateFilters(config, input.message);
  const policy = await getForwardingPolicy(env.DB);
  let folderId = input.inboxFolderId;
  if (result.archive) {
    const folder = await env.DB.prepare("SELECT id FROM folders WHERE user_id=? AND type='archive'").bind(input.userId).first<{ id: string }>();
    if (folder) folderId = folder.id;
  } else if (result.folderId) {
    const folder = await env.DB.prepare("SELECT id FROM folders WHERE id=? AND user_id=? AND type IN ('custom','inbox','archive')").bind(result.folderId, input.userId).first<{ id: string }>();
    if (folder) folderId = folder.id;
  }
  const archived = await env.DB.prepare("SELECT id FROM folders WHERE id=? AND type='archive'").bind(folderId).first();
  const statements: D1PreparedStatement[] = [env.DB.prepare('UPDATE emails SET folder_id=?,is_archived=?,is_read=?,is_starred=? WHERE id=? AND user_id=?')
    .bind(folderId, archived ? 1 : 0, result.markRead ? 1 : 0, result.star ? 1 : 0, input.emailId, input.userId)];
  const destinations = input.blockForwarding ? [] : result.destinations.filter(d => config.destinations.includes(d) && destinationAllowed(d, input.userEmail, env.EMAIL_DOMAIN, policy));
  const keys: string[] = [];
  const jobs: ForwardingQueueJob[] = [];
  if (destinations.length) {
    const prefix = `forwarding/${input.emailId}/`;
    const snapshotKey = `${prefix}message.json`;
    const heading = `Automatically forwarded by ${input.userEmail}\nFrom: ${input.message.from}\nTo: ${input.message.to.join(', ')}\nSubject: ${input.message.subject}\n\n`;
    const snapshot: Snapshot = {
      from: { email: input.userEmail }, to: [], cc: [], bcc: [], subject: input.message.subject,
      replyTo: isValidEmail(input.replyTo || '') ? input.replyTo : isValidEmail(input.message.from) ? input.message.from : undefined,
      html: `<p>${escape(heading).replace(/\n/g, '<br>')}</p>${input.html || `<pre>${escape(input.text)}</pre>`}`,
      text: heading + input.text,
      headers: { 'X-RWA-Auto-Forwarded': '1', 'Auto-Submitted': 'auto-generated' },
      attachments: input.attachments.map((a, i) => ({ filename: a.filename, mimeType: a.mimeType, size: a.content.byteLength, r2Key: `${prefix}part-${i}`, contentId: a.contentId, disposition: a.disposition, shareId: crypto.randomUUID() })),
    };
    await centralDB(env).prepare('INSERT OR IGNORE INTO mailbox_forwarding_snapshots(snapshot_key,user_id) VALUES(?,?)').bind(snapshotKey,input.userId).run();
    keys.push(snapshotKey, ...snapshot.attachments.map(a => a.r2Key));
    try {
      // Sequential writes bound concurrent R2 operations for large MIME messages.
      for (let i = 0; i < snapshot.attachments.length; i++) await env.EMAIL_BUCKET.put(snapshot.attachments[i].r2Key, input.attachments[i].content);
      await env.EMAIL_BUCKET.put(snapshotKey, JSON.stringify(snapshot), { httpMetadata: { contentType: 'application/json' } });
    } catch (error) {
      await Promise.all(keys.map(key => env.EMAIL_BUCKET.delete(key).catch(() => undefined)));
      throw error;
    }
    for (const destination of destinations) {
      const id = generateUUIDv7();
      statements.push(env.DB.prepare(`INSERT INTO forwarding_jobs(id,user_id,source_email_id,destination,subject,snapshot_key,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, input.userId, input.emailId, destination, input.message.subject, snapshotKey, nowIso(), nowIso(), nowIso()));
      jobs.push({ kind: 'forwarding', id, userId: input.userId });
    }
  }
  return { statements, keys, jobs, folderId };
}

interface Job { id: string; user_id: string | null; destination: string; snapshot_key: string; attempts: number }
async function state(env: Env, id: string, status: string, error: string | null, delay = 0) {
  await env.DB.prepare('UPDATE forwarding_jobs SET status=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?')
    .bind(status, error?.slice(0, 500) || null, new Date(Date.now() + delay * 1000).toISOString(), nowIso(), id).run();
}
export async function processForwarding(job: ForwardingQueueJob, env: Env): Promise<void> {
  const owner = job.userId;
  if (!owner) throw new Error('Forwarding job is missing mailbox owner');
  env = await mailboxEnv(env, owner);
  const row = await env.DB.prepare(`UPDATE forwarding_jobs SET status='sending',attempts=attempts+1,updated_at=?
    WHERE id=? AND status='queued' AND next_attempt_at<=? RETURNING id,user_id,destination,snapshot_key,attempts`)
    .bind(nowIso(), job.id, nowIso()).first<Job>();
  if (!row) return;
  let params: SendParams;
  try {
    const user = row.user_id ? await env.DB.prepare('SELECT email,must_reset_password FROM users WHERE id=?').bind(row.user_id).first<{ email: string; must_reset_password: number }>() : null;
    if (!user) { await state(env, row.id, 'cancelled', 'Mailbox account was removed.'); return; }
    const config = await getForwardingConfig(env.DB, row.user_id!);
    const enabled = config.forwardAll === row.destination || config.rules.some(r => r.enabled && r.actions.forwardTo?.includes(row.destination));
    if (!enabled || !config.destinations.includes(row.destination)) { await state(env, row.id, 'cancelled', 'Forwarding to this address was disabled.'); return; }
    if (user.must_reset_password || !destinationAllowed(row.destination, user.email, env.EMAIL_DOMAIN, await getForwardingPolicy(env.DB))) {
      await state(env, row.id, 'failed', 'Forwarding is restricted by account or administrator settings.'); return;
    }
    const object = await env.EMAIL_BUCKET.get(row.snapshot_key);
    if (!object) throw new Error('Saved forwarding copy is unavailable');
    const snapshot = JSON.parse(await object.text()) as Snapshot;
    const bytes = new TextEncoder().encode(snapshot.html + snapshot.text).byteLength + 16_384;
    const asLinks = snapshot.attachments.length > 32 || bytes + snapshot.attachments.reduce((n, a) => n + encodedMessageBytes(a.size) + 300, 0) > MAX_OUTBOUND_MESSAGE_SIZE;
    const attachments: OutboundAttachment[] = [];
    let html = snapshot.html, text = snapshot.text;
    for (const a of snapshot.attachments) {
      const part = await env.EMAIL_BUCKET.get(a.r2Key);
      if (!part) throw new Error('Saved forwarded attachment is unavailable');
      if (asLinks) {
        // Dedicated permanent objects never point back into the source mailbox or job snapshot.
        const key = `shared/${a.shareId}/${a.shareId}`;
        const existing = await env.DB.prepare('SELECT id FROM shared_files WHERE id=?').bind(a.shareId).first();
        if (!existing) {
          await env.EMAIL_BUCKET.put(key, part.body, { httpMetadata: { contentType: a.mimeType } });
          await env.DB.prepare(`INSERT OR IGNORE INTO shared_files(id,user_id,filename,mime_type,size,r2_key,lifecycle) VALUES(?,?,?,?,?,?,'retained')`)
            .bind(a.shareId, row.user_id, a.filename, a.mimeType, a.size, key).run();
        }
        const url = `${env.APP_URL.replace(/\/$/, '')}/api/shared/${a.shareId}`;
        html += `<p>Attachment: <a href="${escape(url)}">${escape(a.filename)}</a></p>`;
        text += `\nAttachment: ${a.filename}\n${url}\n`;
        if (a.contentId) html = html.replace(cidPattern(a.contentId), () => escape(url));
      } else attachments.push({ ...a, id: a.shareId, content: await part.arrayBuffer() });
    }
    if (new TextEncoder().encode(html + text).byteLength + attachments.reduce((n, a) => n + encodedMessageBytes(a.size) + 300, 0) + 16_384 > MAX_OUTBOUND_MESSAGE_SIZE) {
      await state(env, row.id, 'failed', 'The email body exceeds the sending limit. The original email is safe in your mailbox.'); return;
    }
    params = { ...snapshot, from: { email: user.email }, to: [{ email: row.destination }], html, text, attachments };
  } catch {
    await state(env, row.id, row.attempts < 12 ? 'queued' : 'failed', 'Unable to prepare saved forwarding copy.', Math.min(3600, 30 * 2 ** row.attempts));
    return;
  }
  try {
    await sendViaBinding(env, params);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    // Keep diagnostics out of user-visible activity. Never log the snapshot,
    // addresses, attachment data or the provider's complete error object.
    const reason = (error instanceof Error ? error.message : 'Non-Error rejection')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[^\s<>"']+@[^\s<>"']+/g, '[email]')
      .replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '[quoted value]')
      .replace(/\b\d{6,}\b/g, '[number]')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 300);
    console.error('forwarding_send_failed', { jobId: row.id, attempt: row.attempts,
      code: /^E_[A-Z_]+$/.test(code) ? code : 'unknown', reason });
    const retryable = ['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR'].includes(code);
    const known = ['E_VALIDATION_ERROR','E_FIELD_MISSING','E_TOO_MANY_RECIPIENTS','E_TOO_MANY_ATTACHMENTS','E_SENDER_NOT_VERIFIED','E_RECIPIENT_NOT_ALLOWED','E_RECIPIENT_SUPPRESSED','E_SENDER_DOMAIN_NOT_AVAILABLE','E_CONTENT_TOO_LARGE','E_DELIVERY_FAILED','E_HEADER_NOT_ALLOWED','E_HEADER_USE_API_FIELD','E_HEADER_VALUE_INVALID','E_HEADER_VALUE_TOO_LONG','E_HEADER_NAME_INVALID','E_HEADERS_TOO_LARGE','E_HEADERS_TOO_MANY'].includes(code);
    const status = retryable && row.attempts < 12 ? 'queued' : retryable || known ? 'failed' : 'uncertain';
    await state(env, row.id, status, status === 'uncertain' ? 'Delivery could not be confirmed. Check with the recipient before retrying.' : 'Delivery was rejected by the mail provider' + (code ? ` (${code}).` : '.'), code === 'E_DAILY_LIMIT_EXCEEDED' ? 3600 : Math.min(3600, 30 * 2 ** row.attempts));
    return;
  }
  // An ambiguous DB commit after sending stays claimed; dispatchForwarding (mailbox alarm) marks it uncertain.
  await state(env, row.id, 'sent', null);
}

export async function dispatchForwarding(env: Env): Promise<void> {
  if (!env.MAILBOX_USER_ID) throw new Error("Forwarding dispatch requires a mailbox");
  await env.DB.prepare(`UPDATE forwarding_jobs SET status='uncertain',error='Sending was interrupted. Check with the recipient before retrying.',updated_at=? WHERE status='sending' AND updated_at<?`)
    .bind(nowIso(), new Date(Date.now() - 20 * 60_000).toISOString()).run();
  const rows = await env.DB.prepare(`SELECT id,user_id FROM forwarding_jobs WHERE status='queued' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 100`).bind(nowIso()).all<{ id: string; user_id: string }>();
  if (rows.results.length) await env.OUTBOUND_QUEUE.sendBatch(rows.results.map(r => ({ body: { kind: 'forwarding' as const, id: r.id, userId: r.user_id } })));
}

/** Only private delivery snapshots expire. Recipient-facing shared files never do. */
export async function cleanupForwarding(env: Env): Promise<void> {
  if (!env.MAILBOX_USER_ID) throw new Error("Forwarding cleanup requires a mailbox");
  await env.DB.prepare("UPDATE forwarding_jobs SET status='cancelled',updated_at=? WHERE user_id IS NULL AND status NOT IN ('sent','cancelled','sending')").bind(nowIso()).run();
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = await env.DB.prepare(`SELECT DISTINCT snapshot_key FROM forwarding_jobs j WHERE j.status IN ('sent','cancelled') AND j.updated_at<?
    AND NOT EXISTS(SELECT 1 FROM forwarding_jobs active WHERE active.snapshot_key=j.snapshot_key AND (active.status NOT IN ('sent','cancelled') OR active.updated_at>=?)) LIMIT 25`)
    .bind(cutoff, cutoff).all<{ snapshot_key: string }>();
  for (const row of rows.results) {
    const object = await env.EMAIL_BUCKET.get(row.snapshot_key);
    if (object) {
      const snapshot = JSON.parse(await object.text()) as Snapshot;
      for (const part of snapshot.attachments) await env.EMAIL_BUCKET.delete(part.r2Key);
      await env.EMAIL_BUCKET.delete(row.snapshot_key);
    }
    await env.DB.prepare('DELETE FROM forwarding_jobs WHERE snapshot_key=?').bind(row.snapshot_key).run();
    await centralDB(env).prepare('DELETE FROM mailbox_forwarding_snapshots WHERE snapshot_key=?').bind(row.snapshot_key).run();
  }
}

export async function cleanupForwardingSnapshots(env:Env):Promise<void> {
  {
    const reservations=await env.DB.prepare('SELECT snapshot_key,user_id FROM mailbox_forwarding_snapshots WHERE created_at<? ORDER BY created_at LIMIT 25')
      .bind(new Date(Date.now()-86400_000).toISOString()).all<{snapshot_key:string;user_id:string}>();
    for (const reservation of reservations.results) {
      try {
        const scoped=await mailboxEnv(env,reservation.user_id);
        const job=await scoped.DB.prepare('SELECT id FROM forwarding_jobs WHERE snapshot_key=? LIMIT 1').bind(reservation.snapshot_key).first();
        if (!job) {
          const object=await env.EMAIL_BUCKET.get(reservation.snapshot_key);
          if (object) {
            const snapshot=JSON.parse(await object.text()) as Snapshot;
            for (const part of snapshot.attachments) await env.EMAIL_BUCKET.delete(part.r2Key);
            await env.EMAIL_BUCKET.delete(reservation.snapshot_key);
          }
          await env.DB.prepare('DELETE FROM mailbox_forwarding_snapshots WHERE snapshot_key=?').bind(reservation.snapshot_key).run();
        } else await env.DB.prepare('UPDATE mailbox_forwarding_snapshots SET created_at=? WHERE snapshot_key=?').bind(nowIso(),reservation.snapshot_key).run();
      } catch (error) { console.error('Mailbox forwarding reservation cleanup will retry',error); }
    }
  }
  await env.DB.prepare('DELETE FROM forwarding_audit WHERE created_at<?').bind(new Date(Date.now() - 90 * 86400_000).toISOString()).run();
  // Recover snapshot objects orphaned before the atomic mailbox/job commit.
  const cursorRow = await env.DB.prepare("SELECT value FROM settings WHERE key='forwarding_cleanup_cursor'").first<{ value: string }>();
  const listed = await env.EMAIL_BUCKET.list({ prefix: 'forwarding/', limit: 100, ...(cursorRow?.value ? { cursor: cursorRow.value } : {}) });
  for (const object of listed.objects) {
    if (object.uploaded.getTime() > Date.now() - 86400_000) continue;
    const snapshotKey = object.key.split('/').slice(0, 2).join('/') + '/message.json';
    if (await env.DB.prepare('SELECT snapshot_key FROM mailbox_forwarding_snapshots WHERE snapshot_key=?').bind(snapshotKey).first()) continue;
    await env.EMAIL_BUCKET.delete(object.key);
  }
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('forwarding_cleanup_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(listed.truncated ? listed.cursor : '').run();
}
