import type { Database } from "../services/mailbox-storage";
/**
 * Retention Service
 *
 * runRetentionJob runs in each mailbox's alarm (every 15 minutes, via
 * maintainMailbox) in bounded batches:
 *  1. Permanently delete trashed mail older than `delete_trash_after_days`.
 *  2. Archive mail older than `archive_after_days` — moved into the Archive
 *     folder AND flagged, so it leaves the inbox listing but stays searchable
 *     and viewable straight from R2.
 *  3. Trim mailbox housekeeping tables and report any remaining backlog.
 *
 * runCentralCleanup runs from the 15-minute cron against central D1: it sweeps
 * staged inbound objects and abandoned uploads, expired sessions and login attempts.
 */
import { cleanupSharedUploads } from './shared-files';
import type { Env } from '../types';
import { emailBodyTextKey } from '../lib/utils';
import { ftsDeleteManyStatement } from '../lib/fts';
import { LOGIN_ATTEMPT_WINDOW_MS } from '@email-service/shared';

/** Rows handled per round. The loop continues until the backlog is clear. */
export const BATCH_SIZE = 90;
/** Ceiling per run so one mailbox alarm cannot exceed the CPU budget. */
const MAX_PER_RUN = 1_800;
/** How long an unconsumed staged object survives before it is reclaimed. */
const STAGED_TTL_MS = 7 * 86_400_000;

export interface RetentionResult {
  deleted: number;
  archived: number;
  staleStagedRemoved: number;
  abandonedSharedRemoved: number;
  /** Trashed emails still past their cutoff after this run hit its ceiling. */
  remainingTrash: number;
  /** Emails still awaiting archival after this run hit its ceiling. */
  remainingArchive: number;
}

async function settingDays(db: Database, key: string, fallback: number): Promise<number> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{
    value: string;
  }>();
  const parsed = parseInt(row?.value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runRetentionJob(env: Env): Promise<RetentionResult> {
  if (!env.MAILBOX_USER_ID) throw new Error("Mail retention requires a mailbox");
  const archiveAfterDays = await settingDays(env.DB, 'archive_after_days', 365);
  const deleteTrashAfterDays = await settingDays(env.DB, 'delete_trash_after_days', 30);

  // ISO-8601 throughout, matching what the app writes. Comparing ISO strings
  // against SQLite's datetime('now') format silently compares nothing.
  const trashCutoff = new Date(Date.now() - deleteTrashAfterDays * 86_400_000).toISOString();
  const archiveCutoff = new Date(Date.now() - archiveAfterDays * 86_400_000).toISOString();

  let deleted = 0;
  let archived = 0;

  // ─── 1. Purge expired trash ─────────────────────────────────────
  // Keyed on trashed_at, not received_at: an email received two years ago and
  // trashed today must survive its full 30 days, not be destroyed overnight.
  for (let round = 0; round * BATCH_SIZE < MAX_PER_RUN; round++) {
    const batch = await env.DB.prepare(
      `SELECT e.id, e.user_id, e.r2_body_key
       FROM emails e
       JOIN folders f ON f.id = e.folder_id
       WHERE 1=1 AND (e.delivery_status IS NULL OR e.delivery_status IN ('sent', 'failed')) AND f.type = 'trash'
         AND e.trashed_at IS NOT NULL
         AND e.trashed_at < ?
       ORDER BY e.trashed_at ASC
       LIMIT ?`
    )
      .bind(trashCutoff, BATCH_SIZE)
      .all<{ id: string; user_id: string; r2_body_key: string }>();

    if (batch.results.length === 0) break;

    const ids = batch.results.map((e) => e.id);
    const placeholders = ids.map(() => '?').join(',');

    const attachments = await env.DB.prepare(
      `SELECT r2_key FROM attachments WHERE email_id IN (${placeholders})`
    )
      .bind(...ids)
      .all<{ r2_key: string }>();

    // body.html, body.txt and every attachment. body.txt used to be skipped,
    // orphaning one R2 object per deleted email forever.
    const keys = [
      ...batch.results.map((e) => e.r2_body_key),
      ...batch.results.map((e) => e.r2_body_key.replace(/body\.html$/, 'protocol.eml')),
      ...batch.results.map((e) => emailBodyTextKey(e.user_id, e.id, e.r2_body_key)),
      ...attachments.results.map((a) => a.r2_key),
    ];

    // Commit mailbox metadata first, then remove R2 objects. The reverse order meant a failed batch left rows in
    // Trash whose body and attachments had already been deleted — mail the
    // user can see but cannot open. An R2 object orphaned by a failure after
    // the D1 commit is invisible and gets swept below instead.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM emails WHERE id IN (${placeholders})`).bind(...ids),
      ftsDeleteManyStatement(env.DB, ids),
    ]);

    for (let i = 0; i < keys.length; i += 1000) {
      await env.EMAIL_BUCKET.delete(keys.slice(i, i + 1000));
    }

    deleted += ids.length;
    if (batch.results.length < BATCH_SIZE) break;
  }

  // ─── 2. Archive old mail ────────────────────────────────────────
  // Batched like the purge. A single unbounded UPDATE full-scanned `emails`
  // and could blow the CPU budget on a large mailbox.
  for (let round = 0; round * BATCH_SIZE < MAX_PER_RUN; round++) {
    const batch = await env.DB.prepare(
      `SELECT e.id, e.user_id
       FROM emails e
       JOIN folders f ON f.id = e.folder_id
       WHERE 1=1 AND (e.delivery_status IS NULL OR e.delivery_status = 'sent') AND e.is_archived = 0
         AND e.received_at < ?
         AND f.type NOT IN ('trash', 'drafts', 'archive')
       ORDER BY e.received_at ASC
       LIMIT ?`
    )
      .bind(archiveCutoff, BATCH_SIZE)
      .all<{ id: string; user_id: string }>();

    if (batch.results.length === 0) break;

    const ids = batch.results.map((e) => e.id);
    const placeholders = ids.map(() => '?').join(',');

    await env.DB.prepare(
      `UPDATE emails
       SET is_archived = 1,
           folder_id = COALESCE(
             (SELECT id FROM folders WHERE user_id = emails.user_id AND type = 'archive'),
             folder_id
           )
       WHERE id IN (${placeholders})`
    )
      .bind(...ids)
      .run();

    archived += ids.length;
    if (batch.results.length < BATCH_SIZE) break;
  }

  // ─── 3. Bounded housekeeping tables ─────────────────────────────
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM outbound_jobs WHERE email_id IN (SELECT email_id FROM outbound_jobs WHERE status = 'sent' AND updated_at < ? LIMIT 900)`)
      .bind(new Date(now - STAGED_TTL_MS).toISOString()),
    // Idempotency records only need to outlive the queue's retry window.
    env.DB.prepare(`DELETE FROM processed_inbound WHERE processed_at < ?`).bind(
      new Date(now - STAGED_TTL_MS).toISOString()
    ),

  ]);

  // ─── Report any backlog ─────────────────────────────────────────
  // Hitting the per-run ceiling silently looked identical to having nothing to
  // do, so a growing backlog was invisible.
  const remainingTrashRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails e JOIN folders f ON f.id = e.folder_id
     WHERE 1=1 AND (e.delivery_status IS NULL OR e.delivery_status IN ('sent', 'failed')) AND f.type = 'trash' AND e.trashed_at IS NOT NULL AND e.trashed_at < ?`
  )
    .bind(trashCutoff)
    .first<{ n: number }>();

  const remainingArchiveRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM emails e JOIN folders f ON f.id = e.folder_id
     WHERE 1=1 AND (e.delivery_status IS NULL OR e.delivery_status = 'sent') AND e.is_archived = 0 AND e.received_at < ?
       AND f.type NOT IN ('trash', 'drafts', 'archive')`
  )
    .bind(archiveCutoff)
    .first<{ n: number }>();

  return {
    deleted,
    archived,
    staleStagedRemoved:0,
    abandonedSharedRemoved:0,
    remainingTrash: remainingTrashRow?.n || 0,
    remainingArchive: remainingArchiveRow?.n || 0,
  };
}

export async function runCentralCleanup(env:Env) {
  // ─── Sweep abandoned staged objects ─────────────────────────────
  // Unknown-recipient raw MIME and abandoned compose uploads. Raw messages
  // for existing accounts remain recoverable while delivery/migration is pending.
  let staleStagedRemoved = 0;
  const staleCutoff = Date.now() - STAGED_TTL_MS;
  const knownRecipients = new Set((await env.DB.prepare('SELECT email FROM users').all<{email:string}>()).results.map(u=>u.email.toLowerCase()));

  // Persist progress and bound pages, even when a bucket contains only fresh objects.
  for (const prefix of ['inbound/', 'uploads/']) {
    const setting = `sweep_cursor:${prefix}`;
    const saved = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(setting).first<{ value: string }>();
    let cursor = saved?.value || undefined;
    for (let page = 0; page < 2; page++) {
      // R2 documents include; the installed workers-types omits this option.
      const options: R2ListOptions & {include: 'customMetadata'[]} = {prefix,cursor,limit:900,include:['customMetadata']};
      const listed = await env.EMAIL_BUCKET.list(options);
      const stale = listed.objects.filter(o => o.uploaded.getTime() < staleCutoff &&
        !(prefix==='inbound/' && knownRecipients.has(o.customMetadata?.envelopeTo?.trim().toLowerCase() || '')));
      if (stale.length) {
        await env.EMAIL_BUCKET.delete(stale.map(o => o.key));
        staleStagedRemoved += stale.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
      await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(setting, cursor || '').run();
      if (!cursor) break;
    }
  }

  const abandonedSharedRemoved = await cleanupSharedUploads(env);

  const now=Date.now();
  await env.DB.batch([
    // Expired sessions are otherwise only cleared when their owner happens to
    // present them again.
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now).toISOString()),
    // login_attempts is keyed on caller-supplied addresses, so it grows without
    // bound unless expired windows are reclaimed.
    env.DB.prepare('DELETE FROM login_attempts WHERE first_failed_at < ?').bind(
      new Date(now - LOGIN_ATTEMPT_WINDOW_MS).toISOString()
    ),
  ]);

  return {staleStagedRemoved,abandonedSharedRemoved};
}
