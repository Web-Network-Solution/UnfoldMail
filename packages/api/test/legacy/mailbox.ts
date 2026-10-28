import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../src/types';
import { REPORT_SCHEMA } from '../../src/durable-objects/report-schema';
import { MAILBOX_SCHEMA, MAILBOX_TABLES } from '../../src/durable-objects/mailbox-schema';
import { isMailboxQuery, MailboxDatabase, type Query, type QueryResult } from '../../src/services/mailbox-storage';
import { publishMailboxReport } from '../../src/services/mailbox-maintenance';

type Migration = { userId: string; backupId: string; phase: 'copying' | 'verified' | 'active'; table: number; cursor: number; rows: number };
const tables = MAILBOX_TABLES.filter(t => t !== 'mailbox_threads');
function scope(table: string): string {
  return ['attachments','email_shared_files'].includes(table)
    ? 'email_id IN (SELECT id FROM emails WHERE user_id=?)' : 'user_id=?';
}

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
          ctx.storage.sql.exec(MAILBOX_SCHEMA + REPORT_SCHEMA);
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(1)');
        });
      }
      if (!ctx.storage.sql.exec('SELECT version FROM mailbox_schema_version WHERE version=2').toArray().length) {
        ctx.storage.transactionSync(() => {
          ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS mailbox_write_guard (valid INTEGER NOT NULL CHECK(valid=1))');
          ctx.storage.sql.exec('INSERT INTO mailbox_schema_version(version) VALUES(2)');
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
  async begin(userId: string) {
    return this.serial(async () => {
      await this.owner(userId);
      const existing = await this.ctx.storage.get<Migration>('migration');
      if (existing) return existing;
      // This single D1 write serializes against claims by in-flight senders.
      const claim = await this.env.DB.prepare(`INSERT INTO mailbox_routes(user_id,state)
        SELECT ?,'copying' WHERE NOT EXISTS(SELECT 1 FROM outbound_jobs WHERE user_id=? AND status='sending')
        AND NOT EXISTS(SELECT 1 FROM forwarding_jobs WHERE user_id=? AND status='sending')
        ON CONFLICT(user_id) DO UPDATE SET state='copying'
        WHERE mailbox_routes.state='d1'
        AND NOT EXISTS(SELECT 1 FROM outbound_jobs WHERE user_id=? AND status='sending')
        AND NOT EXISTS(SELECT 1 FROM forwarding_jobs WHERE user_id=? AND status='sending')`)
        .bind(userId,userId,userId,userId,userId).run();
      const route = await this.env.DB.prepare('SELECT state FROM mailbox_routes WHERE user_id=?').bind(userId).first<{state:string}>();
      if (!claim.meta.changes && route?.state !== 'copying') throw new Error('Wait for in-progress delivery before migrating this mailbox');
      const state: Migration = { userId, backupId:crypto.randomUUID(), phase: 'copying', table: 0, cursor: 0, rows: 0 };
      await this.ctx.storage.put('migration', state);
      await this.ctx.storage.setAlarm(Date.now()+15*60_000);
      return state;
    });
  }
  /** Resumable bounded pages. Source remains frozen and intact throughout. */
  async copyStep(userId: string) {
    return this.serial(async () => {
      await this.owner(userId);
      const state = await this.ctx.storage.get<Migration>('migration');
      if (!state) throw new Error('Start a migration first');
      if (state.phase==='verified') {
        await this.env.DB.prepare("UPDATE mailbox_routes SET state='verified' WHERE user_id=? AND state='copying'").bind(userId).run();
        return state;
      }
      if (state.phase!=='copying') return state;
      const table = tables[state.table];
      if (!table) throw new Error('Invalid migration cursor');
      const rows = await this.env.DB.prepare(`SELECT rowid AS __source_rowid,* FROM ${table} WHERE ${scope(table)} AND rowid>? ORDER BY rowid LIMIT 40`)
        .bind(userId,state.cursor).all<Record<string,string|number|null>>();
      this.ctx.storage.transactionSync(() => {
        for (const row of rows.results) {
          const { __source_rowid, ...values } = row;
          const columns = Object.keys(values);
          this.ctx.storage.sql.exec(`INSERT OR ${table==='emails_fts' ? 'REPLACE' : 'IGNORE'} INTO ${table}(rowid,${columns.map(c => '"'+c+'"').join(',')}) VALUES (${columns.map(() => '?').concat('?').join(',')})`, __source_rowid,...Object.values(values));
          // Verify the complete copied row, not just a count.
          const saved = this.ctx.storage.sql.exec(`SELECT * FROM ${table} WHERE rowid=?`, __source_rowid).one();
          if (columns.some(c => saved[c] !== values[c])) throw new Error(`Mailbox verification failed: ${table}`);
        }
      });
      await this.env.EMAIL_BUCKET.put(`mailbox-migrations/${userId}/${state.backupId}/${table}/${state.cursor}.json`,JSON.stringify(rows.results));
      if (rows.results.length) { state.cursor=Number(rows.results.at(-1)!.__source_rowid); state.rows+=rows.results.length; }
      if (rows.results.length < 40) { state.table++; state.cursor=0; }
      if (state.table === tables.length) {
        // A second pass over counts catches missing rows; page writes verified every value.
        for (const t of tables) {
          const source = await this.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${scope(t)}`).bind(userId).first<{n:number}>();
          const target = this.ctx.storage.sql.exec<{n:number}>(`SELECT COUNT(*) AS n FROM ${t}`).one();
          if (source?.n !== target.n) throw new Error(`Mailbox count mismatch: ${t}`);
        }
        const violations = this.ctx.storage.sql.exec('PRAGMA foreign_key_check').toArray();
        if (violations.length) throw new Error('Mailbox foreign-key verification failed');
        state.phase='verified';
      }
      await this.ctx.storage.put('migration', state);
      if (state.phase==='verified') await this.env.DB.prepare("UPDATE mailbox_routes SET state='verified' WHERE user_id=? AND state='copying'").bind(userId).run();
      return state;
    });
  }
  async activate(userId: string) {
    return this.serial(async () => {
      await this.owner(userId);
      const state = await this.ctx.storage.get<Migration>('migration');
      if (!state || !['verified','active'].includes(state.phase)) throw new Error('Mailbox must be verified before activation');
      // Prepare aggregates before publishing the route. This private adapter
      // reads the frozen local copy without re-entering execute's serial queue.
      await publishMailboxReport({...this.env,CONTROL_DB:this.env.DB,MAILBOX_USER_ID:userId,
        DB:new MailboxDatabase(this.env.DB,{execute:async(_id,queries)=>this.runQueries(queries)},userId)},
        userId,this.ctx.storage.sql.databaseSize);
      // Pins survive eventual deletion of the old D1 email rows.
      await this.env.DB.prepare(`INSERT OR IGNORE INTO mailbox_shared_pins(user_id,email_id,share_id)
        SELECT ?,r.email_id,r.share_id FROM email_shared_files r JOIN emails e ON e.id=r.email_id WHERE e.user_id=?`)
        .bind(userId,userId).run();
      await this.env.DB.prepare('INSERT OR IGNORE INTO mailbox_forwarding_snapshots(snapshot_key,user_id) SELECT DISTINCT snapshot_key,user_id FROM forwarding_jobs WHERE user_id=?').bind(userId).run();
      state.phase='active';
      await this.ctx.storage.put('migration',state);
      await this.ctx.storage.setAlarm(Date.now()+60_000);
      await this.env.DB.prepare("UPDATE mailbox_routes SET state='active',updated_at=? WHERE user_id=? AND state IN ('copying','verified','active')")
        .bind(new Date().toISOString(),userId).run();
      return state;
    });
  }
  /** Rollback before activation only; never route users to an obsolete D1 snapshot. */
  async abort(userId: string) {
    return this.serial(async () => {
      await this.owner(userId);
      const route = await this.env.DB.prepare('SELECT state FROM mailbox_routes WHERE user_id=?').bind(userId).first<{state:string}>();
      const state = await this.ctx.storage.get<Migration>('migration');
      if (route?.state==='active' || state?.phase==='active') throw new Error('Active mailboxes require a reverse data migration; rollback is blocked');
      this.ctx.storage.transactionSync(() => {
        for (const table of ['email_shared_files','attachments','outbound_jobs','forwarding_jobs','emails_fts','emails','mailbox_threads','processed_inbound','folders','mailbox_days','mailbox_attachment_days']) this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      });
      await this.ctx.storage.delete('migration');
      await this.env.DB.prepare("UPDATE mailbox_routes SET state='d1' WHERE user_id=?").bind(userId).run();
    });
  }
  /** Explicit bounded pruning, after backup, verification and activation. Never touches R2 mail. */
  async pruneLegacy(userId: string) {
    return this.serial(async () => {
      await this.owner(userId);
      const state = await this.ctx.storage.get<Migration>('migration');
      const route = await this.env.DB.prepare('SELECT state FROM mailbox_routes WHERE user_id=?').bind(userId).first<{state:string}>();
      if (state?.phase!=='active' || route?.state!=='active') throw new Error('Activate and verify the mailbox before pruning');
      const rows = await this.env.DB.prepare('SELECT id FROM emails WHERE user_id=? ORDER BY id LIMIT 40').bind(userId).all<{id:string}>();
      const statements = [this.env.DB.prepare('UPDATE mailbox_routes SET purge_legacy=1 WHERE user_id=?').bind(userId)];
      if (rows.results.length) {
        const ids=rows.results.map(r=>r.id), marks=ids.map(()=>'?').join(',');
        statements.push(this.env.DB.prepare(`DELETE FROM emails_fts WHERE email_id IN (${marks}) AND user_id=?`).bind(...ids,userId),
          this.env.DB.prepare(`DELETE FROM emails WHERE id IN (${marks}) AND user_id=?`).bind(...ids,userId));
      } else {
        for (const table of ['processed_inbound','forwarding_jobs']) statements.push(this.env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE user_id=? LIMIT 90)`).bind(userId));
      }
      statements.push(this.env.DB.prepare('UPDATE mailbox_routes SET purge_legacy=0 WHERE user_id=?').bind(userId));
      await this.env.DB.batch(statements);
      const remaining = await this.env.DB.prepare(`SELECT (SELECT COUNT(*) FROM emails WHERE user_id=?)+(SELECT COUNT(*) FROM forwarding_jobs WHERE user_id=?)+(SELECT COUNT(*) FROM processed_inbound WHERE user_id=?) AS n`).bind(userId,userId,userId).first<{n:number}>();
      return { remaining:remaining?.n || 0, backupPrefix:`mailbox-migrations/${userId}/${state.backupId}/` };
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
    const { maintainMailbox } = await import('../../src/services/mailbox-maintenance');
    const last = await this.ctx.storage.get<number>('last-maintenance') || 0;
    const full = Date.now()-last>=15*60_000;
    await maintainMailbox({ ...this.env, CONTROL_DB:this.env.DB, MAILBOX_USER_ID:state.userId,
      DB:new MailboxDatabase(this.env.DB,this,state.userId) },state.userId,this.ctx.storage.sql.databaseSize,full);
    if (full) await this.ctx.storage.put('last-maintenance',Date.now());
    const pending = this.ctx.storage.sql.exec<{n:number}>(`SELECT
      (SELECT COUNT(*) FROM outbound_jobs WHERE status IN ('queued','sending'))+
      (SELECT COUNT(*) FROM forwarding_jobs WHERE status IN ('queued','sending')) AS n`).one();
    await this.ctx.storage.setAlarm(Date.now()+(pending.n ? 60_000 : 15*60_000));
  }
}
