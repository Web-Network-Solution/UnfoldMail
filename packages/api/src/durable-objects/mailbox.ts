import { DurableObject } from 'cloudflare:workers';
import { SYSTEM_FOLDERS, SYSTEM_FOLDER_LABELS } from '@email-service/shared';
import type { Env } from '../types';
import { REPORT_SCHEMA } from './report-schema';
import { MAILBOX_SCHEMA } from './mailbox-schema';
import { PROTOCOL_SCHEMA, PROTOCOL_CLEANUP_SCHEMA, PROTOCOL_CHANGES_SCHEMA } from './protocol-schema';
import { isMailboxQuery, MailboxDatabase, type Query, type QueryResult } from '../services/mailbox-storage';
import { publishMailboxReport } from '../services/mailbox-maintenance';

type Migration = { userId: string; backupId: string; phase: 'copying' | 'verified' | 'active'; table: number; cursor: number; rows: number };
/** Private binding only. The HTTP API never exposes execute() or accepts SQL. */
export class MailboxDO extends DurableObject<Env> {
  private pending: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn, fn);
    this.pending = next.catch(() => undefined);
    return next;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mailbox_schema_version(version INTEGER PRIMARY KEY)');
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec(MAILBOX_SCHEMA);
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(1)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=2').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mailbox_write_guard (valid INTEGER NOT NULL CHECK(valid=1))');
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(2)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=3').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ai_candidates(id TEXT PRIMARY KEY,sender TEXT NOT NULL,subject TEXT NOT NULL,automated INTEGER NOT NULL,created INTEGER NOT NULL)');
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(3)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=4').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec(PROTOCOL_SCHEMA);
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(4)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=5').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec(PROTOCOL_CLEANUP_SCHEMA);
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(5)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=6').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec(PROTOCOL_CHANGES_SCHEMA);
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(6)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=7').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec(REPORT_SCHEMA);
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(7)');
        });
      }
    });
  }
  private async owner(userId: string) {
    if (this.ctx.id.toString() !== this.env.MAILBOXES!.idFromName(userId).toString()) throw new Error('Mailbox identity mismatch');
    if (!await this.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()) throw new Error('Mailbox account does not exist');
  }
  async execute(userId: string, queries: Query[]): Promise<QueryResult[]> {
    return this.serial(async () => {
      await this.owner(userId);
      const state = await this.ctx.storage.get<Migration>('migration');
      if (state?.phase !== 'active') throw new Error('Mailbox maintenance is in progress');
      if (queries.length > 1000 || queries.some(q => !isMailboxQuery(q.sql) || q.values.length > 100)) throw new Error('Invalid mailbox transaction');
      // Schedule before committing: if publication fails, the alarm still repairs it.
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm || (alarm>Date.now()+60_000 && queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)/i.test(q.sql)))) await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return this.runQueries(queries);
    });
  }
  private runQueries(queries:Query[]):QueryResult[] {
      return this.ctx.storage.transactionSync(() => queries.map(q => {
        const cursor = this.ctx.storage.sql.exec(q.sql, ...q.values);
        const results = cursor.toArray();
        const changes = /^(?:\s*)(?:SELECT|WITH|PRAGMA)\b/i.test(q.sql) ? 0
          : Number(this.ctx.storage.sql.exec<{n:number}>('SELECT changes() AS n').one().n);
        return { results, changes };
      }));
  }
  async status(userId: string) {
    await this.owner(userId);
    return { migration: await this.ctx.storage.get<Migration>('migration') || null, databaseBytes: this.ctx.storage.sql.databaseSize };
  }
  /** Only newly created accounts may initialize an empty mailbox. Retry-safe. */
  async provision(userId: string) {
    return this.serial(async () => {
      await this.owner(userId);
      const route = await this.env.DB.prepare('SELECT state,provision_new FROM mailbox_routes WHERE user_id=?').bind(userId).first<{state:string;provision_new:number}>();
      const existing = await this.ctx.storage.get<Migration>('migration');
      if (route?.state === 'active' && existing?.phase === 'active') return;
      if (!route?.provision_new) throw new Error('Mailbox requires recovery; empty initialization refused');
      if (!existing) {
        this.ctx.storage.transactionSync(() => {
          for (const type of SYSTEM_FOLDERS) this.ctx.storage.sql.exec(
            'INSERT OR IGNORE INTO folders(id,user_id,name,type,created_at) VALUES(?,?,?,?,?)',
            `${userId}:${type}`, userId, SYSTEM_FOLDER_LABELS[type] || type, type, new Date().toISOString());
        });
        await this.ctx.storage.put('migration',{userId,phase:'active',backupId:'',table:0,cursor:0,rows:0});
      }
      await this.ctx.storage.setAlarm(Date.now()+60_000);
      await publishMailboxReport({...this.env,CONTROL_DB:this.env.DB,MAILBOX_USER_ID:userId,
        DB:new MailboxDatabase(this.env.DB,{execute:async(_id,queries)=>this.runQueries(queries)},userId)},userId,this.ctx.storage.sql.databaseSize);
      await this.env.DB.prepare("UPDATE mailbox_routes SET state='active',provision_new=0,updated_at=? WHERE user_id=? AND provision_new=1")
        .bind(new Date().toISOString(),userId).run();
    });
  }
  /** Internal cleanup is allowed only after central account deletion. */
  async destroyDeletedAccount(userId:string) {
    return this.serial(async()=>{
      if(this.ctx.id.toString()!==this.env.MAILBOXES!.idFromName(userId).toString()) throw new Error('Mailbox identity mismatch');
      if(await this.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(userId).first()) throw new Error('Cannot destroy an existing account');
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }
  async alarm() {
    const state = await this.ctx.storage.get<Migration>('migration');
    if (!state) return;
    if (!await this.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(state.userId).first()) {
      await this.destroyDeletedAccount(state.userId);
      return;
    }
    if (state.phase !== 'active') {
      await this.ctx.storage.setAlarm(Date.now()+15*60_000);
      return;
    }
    // Reschedule first so transient failures never disable recovery.
    await this.ctx.storage.setAlarm(Date.now()+60_000);
    const { maintainMailbox } = await import('../services/mailbox-maintenance');
    const last = await this.ctx.storage.get<number>('last-maintenance') || 0;
    const full = Date.now()-last>=15*60_000;
    await maintainMailbox({ ...this.env, CONTROL_DB:this.env.DB, MAILBOX_USER_ID:state.userId,
      DB:new MailboxDatabase(this.env.DB,this,state.userId) },state.userId,this.ctx.storage.sql.databaseSize,full);
    if (full) await this.ctx.storage.put('last-maintenance',Date.now());
    if (this.env.AI_ASSISTANTS) {
      this.ctx.storage.sql.exec('DELETE FROM ai_candidates WHERE created<?',Date.now()-86400000);
      const candidates=this.ctx.storage.sql.exec<{id:string;sender:string;subject:string;automated:number}>('SELECT id,sender,subject,automated FROM ai_candidates ORDER BY created LIMIT 10').toArray();
      for(const email of candidates) {
        try {await this.env.AI_ASSISTANTS.get(this.env.AI_ASSISTANTS.idFromName(state.userId)).enqueue(state.userId,{...email,automated:!!email.automated});this.ctx.storage.sql.exec('DELETE FROM ai_candidates WHERE id=?',email.id);}
        catch { /* Durable candidate remains for the next alarm. Mail delivery is unaffected. */ }
      }
    }

    const pending = this.ctx.storage.sql.exec<{n:number}>(`SELECT
      (SELECT COUNT(*) FROM outbound_jobs WHERE status IN ('queued','sending'))+
      (SELECT COUNT(*) FROM ai_candidates)+(SELECT COUNT(*) FROM forwarding_jobs WHERE status IN ('queued','sending')) AS n`).one();
    await this.ctx.storage.setAlarm(Date.now()+(pending.n ? 60_000 : 15*60_000));
  }
}
