import type { Env } from '../types';
export interface MailboxMetric {
  user_id:string; emails:number; bytes:number; attachments:number; attachment_bytes:number;
  sent:number; received:number; today:number; week:number;
}
export async function mailboxMetrics(env:Env) {
  return (await env.DB.prepare("SELECT m.* FROM mailbox_metrics m JOIN mailbox_routes r ON r.user_id=m.user_id WHERE r.state='active'").all<MailboxMetric>()).results;
}
export interface Day { day:string;n:number;bytes:number;sent:number;received:number;sent_bytes:number;received_bytes:number }
export interface AttachmentDay { day:string;n:number;bytes:number }
export interface ReportSnapshot { emails:Day[];attachments:AttachmentDay[];updatedAt:string }
export class MailboxReportPending extends Error {
  constructor() { super('A mailbox report is being rebuilt. Please retry shortly.'); }
}

/** Published summaries are a durable cache; request work is restricted to the selected dates. */
export async function readMailboxReports(env:Env,start:string,end:string) {
  const [states,days] = await Promise.all([
    env.DB.prepare(`SELECT r.user_id,s.updated_at,s.history_since FROM mailbox_routes r
      LEFT JOIN mailbox_report_state s ON s.user_id=r.user_id WHERE r.state='active'`).all<{user_id:string;updated_at:string|null;history_since:string|null}>(),
    env.DB.prepare(`SELECT d.* FROM mailbox_report_days d JOIN mailbox_routes r ON r.user_id=d.user_id
      WHERE d.day>=? AND d.day<=? AND r.state='active'`).bind(start,end)
      .all<Day & {user_id:string;attachments:number;attachment_bytes:number}>(),
  ]);
  const reports=new Map<string,{userId:string;report:ReportSnapshot}>();
  for (const row of states.results) if(row.updated_at) reports.set(row.user_id,{userId:row.user_id,report:{emails:[],attachments:[],updatedAt:row.updated_at}});
  for (const row of days.results) {
    const report=reports.get(row.user_id)?.report;
    if (!report) continue;
    report.emails.push(row);
    report.attachments.push({day:row.day,n:row.attachments,bytes:row.attachment_bytes});
  }
  const timestamps=states.results.flatMap(r=>r.updated_at?[r.updated_at]:[]).sort();
  return { reports:[...reports.values()], freshness:{
    updatedAt:timestamps[0] || null,
    missingMailboxes:states.results.filter(r=>!r.updated_at).length,
    staleMailboxes:states.results.filter(r=>r.updated_at && Date.parse(r.updated_at)<Date.now()-30*60_000).length,
    historicalBaselineIncomplete:states.results.some(r=>!r.history_since || start<=r.history_since.slice(0,10)),
  }};
}
