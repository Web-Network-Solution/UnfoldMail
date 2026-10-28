import type { Env } from '../types';
import { centralDB, mailboxStub } from './mailbox-storage';
import { revokeSockets } from '../lib/utils';

/** Durable tombstones survive account deletion and every external-storage failure. */
export async function cleanupDeletedMailbox(env: Env, userId: string): Promise<boolean> {
  const db=centralDB(env);
  const job=await db.prepare('SELECT prefix_index FROM mailbox_deletions WHERE user_id=?').bind(userId).first<{prefix_index:number}>();
  if (!job) return true;
  if (await db.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()) throw new Error('Cannot clean up an existing account');
  if (job.prefix_index===-1) {
    // First and repeated until the tombstone advances, so a failing DO does not
    // keep the deleted account's sockets open. Best-effort.
    await revokeSockets(env,userId);
    await mailboxStub(env,userId).destroyDeletedAccount(userId);
    if(env.AI_ASSISTANTS) await env.AI_ASSISTANTS.get(env.AI_ASSISTANTS.idFromName(userId)).destroyDeletedAccount(userId);
    await db.batch([
      db.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId),
      db.prepare('UPDATE mailbox_deletions SET prefix_index=0 WHERE user_id=? AND prefix_index=-1').bind(userId),
    ]);
  }
  const index=Math.max(0,job.prefix_index);
  const prefixes=[`emails/${userId}/`,`attachments/${userId}/`,`uploads/${userId}/`,`mailbox-migrations/${userId}/`];
  const listed=await env.EMAIL_BUCKET.list({prefix:prefixes[index],limit:500});
  if (listed.objects.length) await env.EMAIL_BUCKET.delete(listed.objects.map(o=>o.key));
  // Always list the first page again: deletion removes it, so no stale R2 cursor
  // is needed. Concurrent recovery attempts are safe and advance by CAS.
  if (!listed.truncated) {
    if(index===prefixes.length-1) {
      await env.EMAIL_BUCKET.delete(`mailbox-reports/${userId}.json`);
      await db.prepare('DELETE FROM mailbox_deletions WHERE user_id=? AND prefix_index=?').bind(userId,index).run();
      return true;
    }
    await db.prepare('UPDATE mailbox_deletions SET prefix_index=prefix_index+1,updated_at=? WHERE user_id=? AND prefix_index=?')
      .bind(new Date().toISOString(),userId,index).run();
  }
  return false;
}

export async function cleanupDeletedMailboxes(env:Env):Promise<void> {
  const rows=await centralDB(env).prepare('SELECT user_id FROM mailbox_deletions ORDER BY updated_at LIMIT 10').all<{user_id:string}>();
  for (const row of rows.results) {
    try { await cleanupDeletedMailbox(env,row.user_id); }
    catch(error) { console.error('Account cleanup will retry',{userId:row.user_id,error}); }
  }
}
