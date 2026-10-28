import type { Env } from '../types';
import type { MailboxDO } from '../durable-objects/mailbox';

export type Database = Pick<D1Database, 'prepare' | 'batch'>;
export interface Query { sql: string; values: (string | number | null)[] }
export type QueryResult = { results: Record<string, unknown>[]; changes: number };
export const LOCAL_TABLES = ['protocol_changes', 'protocol_object_gc', 'protocol_state', 'protocol_notices', 'protocol_messages', 'protocol_imports', 'protocol_subscriptions', 'folders', 'emails', 'attachments', 'emails_fts', 'mailbox_threads', 'processed_inbound', 'outbound_jobs', 'forwarding_jobs', 'email_shared_files', 'mailbox_activity', 'mailbox_activity_days', 'mailbox_report_meta', 'mailbox_days', 'mailbox_attachment_days', 'mailbox_write_guard', 'ai_candidates'];
/** Every table in schema/fresh.sql. Keep in sync: the mail-fixes test compares them. */
const CENTRAL_TABLES = ['protocol_passwords', 'protocol_user_access', 'settings', 'login_attempts', 'users', 'sessions', 'shared_files', 'shared_uploads', 'shared_upload_parts', 'forwarding_configs', 'forwarding_audit', 'contacts', 'calendar_events', 'calendar_attendees', 'calendar_deliveries', 'mailbox_routes', 'mailbox_report_days', 'mailbox_report_state', 'mailbox_metrics', 'mailbox_shared_pins', 'mailbox_forwarding_snapshots', 'mailbox_deletions', 'd1_migrations'];

/** SQL is application-owned, never accepted from an HTTP caller. Fail on cross-store joins. */
export function isMailboxQuery(sql: string): boolean {
  const clean = sql.replace(/'([^']|'')*'/g, "''");
  const names = [...clean.matchAll(/\b(?:from|join|into|update)\s+["`]?(\w+)/gi)].map(m => m[1].toLowerCase());
  const local = names.some(n => LOCAL_TABLES.includes(n));
  if (local && names.some(n => CENTRAL_TABLES.includes(n))) {
    throw new Error('Cross-store mailbox query must be split explicitly');
  }
  return local;
}

export function mailboxStub(env: Env, userId: string): DurableObjectStub<MailboxDO> {
  if (!env.MAILBOXES) throw new Error('Mailbox storage binding is unavailable');
  return env.MAILBOXES.get(env.MAILBOXES.idFromName(userId));
}
export function centralDB(env: Env): Database { return env.CONTROL_DB || env.DB; }

export class MailboxUnavailable extends Error {
  constructor() { super('Mailbox maintenance is in progress. Please retry shortly.'); }
}

/** Select storage afresh for every request/job. Never cache routing across requests. */
export async function mailboxEnv(env: Env, userId: string): Promise<Env> {
  if (env.MAILBOX_USER_ID === userId) return env;
  const db = centralDB(env);
  if (!env.MAILBOXES) throw new MailboxUnavailable();
  const route = await db.prepare('SELECT state,provision_new FROM mailbox_routes WHERE user_id=?').bind(userId).first<{state:string;provision_new:number}>();
  if (route?.provision_new) await mailboxStub(env,userId).provision(userId);
  else if (route?.state !== 'active') throw new MailboxUnavailable();
  return { ...env, CONTROL_DB: db, DB: new MailboxDatabase(db, mailboxStub(env, userId), userId), MAILBOX_USER_ID: userId };
}

function result<T>(r: QueryResult): D1Result<T> {
  return { success: true, results: r.results as T[], meta: {
    changes: r.changes, duration: 0, last_row_id: 0, changed_db: r.changes > 0,
    size_after: 0, rows_read: 0, rows_written: r.changes,
  } };
}
class Statement implements D1PreparedStatement {
  constructor(readonly owner: MailboxDatabase, readonly sql: string, readonly values: (string | number | null)[] = []) {}
  bind(...values: unknown[]): D1PreparedStatement {
    if (values.length > 100 || values.some(v => v !== null && typeof v !== 'string' && typeof v !== 'number')) throw new Error('Invalid mailbox SQL parameters');
    return new Statement(this.owner, this.sql, values as (string | number | null)[]);
  }
  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = (await this.all<Record<string, unknown>>()).results[0];
    return (row ? column ? row[column] : row : null) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> { return (await this.owner.batch<T>([this]))[0]; }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.all<T>(); }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = (await this.all<Record<string, unknown>>()).results;
    const values = rows.map(Object.values) as T[];
    return options?.columnNames ? [rows.length ? Object.keys(rows[0]) : [], ...values] : values;
  }
}

export class MailboxDatabase implements Database {
  constructor(readonly central: Database, readonly stub: Pick<MailboxDO, 'execute'>, readonly userId: string) {}
  prepare(sql: string): D1PreparedStatement {
    return isMailboxQuery(sql) ? new Statement(this, sql) : this.central.prepare(sql);
  }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (!statements.length) return [];
    if (statements.every(s => !(s instanceof Statement))) return this.central.batch<T>(statements);
    if (!statements.every(s => s instanceof Statement && s.owner === this)) throw new Error('Cross-store transaction must be split explicitly');
    const queries = statements.map(s => { const v = s as Statement; return { sql: v.sql, values: v.values }; });
    return (await this.stub.execute(this.userId, queries)).map(r => result<T>(r));
  }
}

/** Provisioning survives a failed account-creation HTTP response. */
export async function provisionMailboxes(env:Env):Promise<void> {
  const pending=await centralDB(env).prepare('SELECT user_id FROM mailbox_routes WHERE provision_new=1 LIMIT 10').all<{user_id:string}>();
  for(const row of pending.results) {
    try { await mailboxStub(env,row.user_id).provision(row.user_id); }
    catch(error) { console.error('Mailbox provisioning will retry',{userId:row.user_id,error}); }
  }
}
