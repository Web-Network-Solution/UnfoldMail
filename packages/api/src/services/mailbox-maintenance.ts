import { cleanupProtocolObjects } from './protocol-cleanup';
import type { Env } from '../types';
import { centralDB } from './mailbox-storage';
import { dispatchOutbox } from './outbox';
import { dispatchForwarding, cleanupForwarding } from './forwarding';
import { runRetentionJob } from './retention';
import type { Day, AttachmentDay } from './mailbox-reporting';

/** Runs inside each active mailbox's alarm, so cron never fans out to every employee. */
export async function maintainMailbox(env: Env, userId: string, databaseBytes: number, full = true): Promise<void> {
  // Reporting is independent of delivery and retention failures.
  if (full) {
    try { await publishMailboxReport(env,userId,databaseBytes); }
    catch (error) { console.error('Mailbox report publication failed', {userId,error}); }
  }
  await cleanupProtocolObjects(env);
  await dispatchOutbox(env);
  await dispatchForwarding(env);
  if (!full) return;
  const retention = await runRetentionJob(env);
  if (retention.remainingTrash || retention.remainingArchive) console.warn('Mail retention backlog', { userId, remainingTrash: retention.remainingTrash, remainingArchive: retention.remainingArchive });
  await cleanupForwarding(env);
  // Stale pins are safe to release only after checking the authoritative mailbox.
  const pins = await centralDB(env).prepare('SELECT email_id,share_id,created_at FROM mailbox_shared_pins WHERE user_id=? AND created_at<? ORDER BY created_at LIMIT 90')
    .bind(userId,new Date(Date.now()-7*86400_000).toISOString()).all<{email_id:string;share_id:string;created_at:string}>();
  for (const pin of pins.results) {
    const referenced = await env.DB.prepare('SELECT e.delivery_status FROM email_shared_files r JOIN emails e ON e.id=r.email_id WHERE r.email_id=? AND r.share_id=?').bind(pin.email_id,pin.share_id).first<{delivery_status:string|null}>();
    const file = await centralDB(env).prepare('SELECT lifecycle FROM shared_files WHERE id=?').bind(pin.share_id).first<{lifecycle:string}>();
    // Only committed sends have a delivery status: finish a best-effort retention that failed.
    if (referenced?.delivery_status && file?.lifecycle==='staged') {
      await centralDB(env).prepare("UPDATE shared_files SET lifecycle='retained' WHERE id=? AND lifecycle='staged'").bind(pin.share_id).run();
      file.lifecycle='retained';
    }
    if (!referenced || file?.lifecycle==='retained') await centralDB(env).prepare('DELETE FROM mailbox_shared_pins WHERE user_id=? AND email_id=? AND share_id=? AND created_at=?').bind(userId,pin.email_id,pin.share_id,pin.created_at).run();
    else await centralDB(env).prepare('UPDATE mailbox_shared_pins SET created_at=? WHERE user_id=? AND email_id=? AND share_id=? AND created_at=?').bind(new Date().toISOString(),userId,pin.email_id,pin.share_id,pin.created_at).run();
  }
}

/** Also used before activation, so reports are immediately available. */
export async function publishMailboxReport(env:Env,userId:string,databaseBytes:number):Promise<void> {
  const stats = await env.DB.prepare(`SELECT COALESCE(SUM(n),0) AS emails,COALESCE(SUM(bytes),0) AS bytes,
    COALESCE(SUM(sent),0) AS sent,COALESCE(SUM(received),0) AS received,
    (SELECT COUNT(*) FROM emails WHERE received_at>=?) AS today,
    (SELECT COUNT(*) FROM emails WHERE received_at>=?) AS week FROM mailbox_days`)
    .bind(new Date(Date.now()-86400_000).toISOString(),new Date(Date.now()-7*86400_000).toISOString())
    .first<{emails:number;bytes:number;sent:number;received:number;today:number;week:number}>();
  const attachments = await env.DB.prepare('SELECT COALESCE(SUM(n),0) AS n,COALESCE(SUM(bytes),0) AS bytes FROM mailbox_attachment_days').first<{n:number;bytes:number}>();
  if (!stats || !attachments) return;
  const days=await env.DB.prepare(`SELECT d.day,COALESCE(a.sent,0)+COALESCE(a.received,0) AS n,
    COALESCE(m.bytes,0) AS bytes,COALESCE(a.sent,0) AS sent,COALESCE(a.received,0) AS received,
    COALESCE(a.sent_bytes,0) AS sent_bytes,COALESCE(a.received_bytes,0) AS received_bytes
    FROM (SELECT day FROM mailbox_days UNION SELECT day FROM mailbox_activity_days) d
    LEFT JOIN mailbox_days m ON m.day=d.day LEFT JOIN mailbox_activity_days a ON a.day=d.day ORDER BY d.day`).all<Day>();
  const attachmentDays=await env.DB.prepare('SELECT * FROM mailbox_attachment_days ORDER BY day').all<AttachmentDay>();
  const history = await env.DB.prepare('SELECT since FROM mailbox_report_meta LIMIT 1').first<{since:string}>();
  const updatedAt = new Date().toISOString();
  const rows = new Map(days.results.map(d=>[d.day,{...d,attachments:0,attachment_bytes:0}]));
  for (const a of attachmentDays.results) {
    const row=rows.get(a.day) || {day:a.day,n:0,bytes:0,sent:0,received:0,sent_bytes:0,received_bytes:0,attachments:0,attachment_bytes:0};
    row.attachments=a.n; row.attachment_bytes=a.bytes; rows.set(a.day,row);
  }
  // A transaction preserves the last complete publication if any write fails.
  await centralDB(env).batch([
    centralDB(env).prepare(`INSERT INTO mailbox_report_days
      SELECT ?,json_extract(value,'$.day'),json_extract(value,'$.n'),json_extract(value,'$.bytes'),
      json_extract(value,'$.sent'),json_extract(value,'$.received'),json_extract(value,'$.sent_bytes'),
      json_extract(value,'$.received_bytes'),json_extract(value,'$.attachments'),json_extract(value,'$.attachment_bytes') FROM json_each(?) WHERE true
      ON CONFLICT(user_id,day) DO UPDATE SET n=excluded.n,bytes=excluded.bytes,sent=excluded.sent,received=excluded.received,
      sent_bytes=excluded.sent_bytes,received_bytes=excluded.received_bytes,attachments=excluded.attachments,attachment_bytes=excluded.attachment_bytes
      WHERE n!=excluded.n OR bytes!=excluded.bytes OR sent!=excluded.sent OR received!=excluded.received
        OR sent_bytes!=excluded.sent_bytes OR received_bytes!=excluded.received_bytes OR attachments!=excluded.attachments OR attachment_bytes!=excluded.attachment_bytes`)
      .bind(userId,JSON.stringify([...rows.values()])),
    centralDB(env).prepare(`INSERT INTO mailbox_report_state(user_id,updated_at,history_since) VALUES(?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET updated_at=excluded.updated_at,history_since=excluded.history_since`)
      .bind(userId,updatedAt,history?.since || updatedAt),
  ]);
  await env.EMAIL_BUCKET.put(`mailbox-reports/${userId}.json`,JSON.stringify({emails:days.results,attachments:attachmentDays.results,updatedAt:new Date().toISOString()}));
  await centralDB(env).prepare(`INSERT INTO mailbox_metrics(user_id,emails,bytes,attachments,attachment_bytes,sent,received,today,week,database_bytes,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET emails=excluded.emails,bytes=excluded.bytes,
    attachments=excluded.attachments,attachment_bytes=excluded.attachment_bytes,sent=excluded.sent,received=excluded.received,
    today=excluded.today,week=excluded.week,database_bytes=excluded.database_bytes,updated_at=excluded.updated_at`)
    .bind(userId,stats.emails,stats.bytes,attachments.n,attachments.bytes,stats.sent,stats.received,stats.today,stats.week,databaseBytes,new Date().toISOString()).run();
}
