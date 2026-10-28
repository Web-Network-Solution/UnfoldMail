import { centralDB } from './mailbox-storage';
import type { Env } from '../types';

/** Inspect actual message content, including reopened drafts, quotes and signatures. */
export function sharedLinkIds(content: string, appUrl: string): string[] {
  const origin = new URL(appUrl).origin;
  const ids = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s<>"']+|\/api\/shared\/[a-zA-Z0-9-]+/g)) {
    let url: URL;
    try { url = new URL(match[0].replace(/&amp;/g, '&'), origin); }
    catch { continue; }
    if (url.origin !== origin) continue;
    const path = /^\/api\/shared\/([a-zA-Z0-9-]+)\/?$/.exec(url.pathname);
    if (path) ids.add(path[1]);
  }
  return [...ids];
}

export async function sharedFileStatements(
  env: Env, emailId: string, userId: string, html: string, text: string
): Promise<D1PreparedStatement[]> {
  const ids = sharedLinkIds(html + '\n' + text, env.APP_URL);
  if (ids.length > 100) throw new Error('At most 100 shared-file links are allowed per message');
  const statements = [env.DB.prepare('DELETE FROM email_shared_files WHERE email_id = ?').bind(emailId)];
  for (const id of ids) {
    const file = await env.DB.prepare('SELECT user_id, lifecycle FROM shared_files WHERE id = ? AND NOT EXISTS (SELECT 1 FROM shared_uploads WHERE share_id = shared_files.id)')
      .bind(id).first<{ user_id: string | null; lifecycle: string }>();
    if (!file || file.lifecycle === 'deleting') throw new Error('A shared file is no longer available. Upload it again before saving or sending.');
    if (file.lifecycle === 'staged' && file.user_id !== userId) throw new Error('This shared upload has not been released by its owner.');
    statements.push(env.DB.prepare('INSERT INTO email_shared_files(email_id, share_id) VALUES (?, ?)').bind(emailId, id));
    // The pin protects the file from cleanup before the mailbox write, including
    // failed saves; mailbox maintenance releases pins nothing references.
    await centralDB(env).prepare("INSERT INTO mailbox_shared_pins(user_id,email_id,share_id) VALUES(?,?,?) ON CONFLICT(user_id,email_id,share_id) DO UPDATE SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(userId,emailId,id).run();
  }
  return statements;
}

/**
 * Permanent retention, only once a send is committed: a rejected send must not
 * keep files forever. Best-effort after the commit; the pins protect the files
 * until then. `strict` throws instead: processOutbound retains before every
 * provider call, so no delivered link can outlive an unretained file (the Sent
 * copy, and with it the pin, may be deleted once the job is sent).
 * Failed/uncertain delivery never removes a link.
 */
export async function retainSharedFiles(env: Env, html: string, text: string, strict = false): Promise<void> {
  const ids = sharedLinkIds(html + '\n' + text, env.APP_URL);
  if (!ids.length) return;
  const db = centralDB(env);
  const retained = db.batch(ids.map(id => db.prepare("UPDATE shared_files SET lifecycle='retained' WHERE id=? AND lifecycle!='deleting'").bind(id)));
  await (strict ? retained : retained.catch(error => console.error('Shared-file retention will be retried before delivery', error)));
}

/** Claim first, delete R2 second, remove metadata last; retry failed deletions. */
export async function cleanupSharedUploads(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await env.DB.prepare(`UPDATE shared_files SET lifecycle = 'deleting'
    WHERE id IN (SELECT s.id FROM shared_files s WHERE s.lifecycle = 'staged' AND s.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM mailbox_shared_pins p WHERE p.share_id=s.id)
      ORDER BY s.created_at LIMIT 90)`)
    .bind(cutoff).run();
  const rows = await env.DB.prepare("SELECT id, r2_key FROM shared_files WHERE lifecycle = 'deleting' ORDER BY created_at LIMIT 90")
    .all<{ id: string; r2_key: string }>();
  let deleted = 0;
  for (const row of rows.results) {
    try {
      const upload = await env.DB.prepare('SELECT upload_id FROM shared_uploads WHERE share_id=?').bind(row.id).first<{upload_id:string|null}>();
      if (upload?.upload_id) {
        try { await env.EMAIL_BUCKET.resumeMultipartUpload(row.r2_key,upload.upload_id).abort(); }
        catch (error) { if (!/NoSuchUpload|does not exist|10024/i.test(String(error))) throw error; }
      }
      await env.EMAIL_BUCKET.delete(row.r2_key);
      await env.DB.prepare("DELETE FROM shared_files WHERE id = ? AND lifecycle = 'deleting'").bind(row.id).run();
      deleted++;
    } catch (error) {
      console.error('Shared upload cleanup will retry', { shareId: row.id, error });
    }
  }
  return deleted;
}
