import type { Env } from '../types';
import { nowIso } from '../lib/utils';
/** Delete only objects whose owning import/deletion no longer has an email row.
 * The claim fences late import commits through mailbox_write_guard. Failed R2
 * operations retain the intent, with backoff, for the next mailbox alarm.
 */
export async function cleanupProtocolObjects(env: Env, onlyId?: string): Promise<void> {
    const now = nowIso();
    const jobs = await env.DB.prepare(`SELECT id,email_id,keys_json FROM protocol_object_gc
    WHERE not_before<=? ${onlyId ? 'AND id=?' : ''} ORDER BY not_before LIMIT 10`)
        .bind(...(onlyId ? [now, onlyId] : [now])).all<{
        id: string;
        email_id: string;
        keys_json: string;
    }>();
    for (const job of jobs.results) {
        const claim = await env.DB.prepare(`UPDATE protocol_object_gc SET state='deleting',not_before=?
      WHERE id=? AND not_before<=? AND NOT EXISTS(SELECT 1 FROM emails WHERE id=?)`)
            .bind(new Date(Date.now() + 60000).toISOString(), job.id, now, job.email_id).run();
        if (!claim.meta.changes)
            continue;
        try {
            const keys: string[] = JSON.parse(job.keys_json);
            for (let i = 0; i < keys.length; i += 1000)
                await env.EMAIL_BUCKET.delete(keys.slice(i, i + 1000));
            await env.DB.prepare("DELETE FROM protocol_object_gc WHERE id=? AND state='deleting'").bind(job.id).run();
        }
        catch {
            // The durable intent remains retryable even if the Worker stops here.
            console.error('Protocol object cleanup will retry');
        }
    }
}
