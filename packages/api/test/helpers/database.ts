import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Real SQL with Cloudflare's parameter limit, which plain SQLite does not enforce. */
export function testDatabase(fresh = false) {
  const sqlite = new DatabaseSync(':memory:');
  const dir = join(__dirname, '../../migrations');
  if (fresh) {
    sqlite.exec(readFileSync(join(__dirname, '../../schema/fresh.sql'), 'utf8'));
    const applied=new Set(sqlite.prepare('SELECT name FROM d1_migrations').all().map(r=>r.name));
    for(const file of readdirSync(dir).sort()) if(!applied.has(file)) sqlite.exec(readFileSync(join(dir,file),'utf8'));
  }
  else for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  // Unit fixtures populate mailbox SQL directly; provisioning is tested separately.
  if (!fresh) sqlite.exec('DROP TRIGGER provision_new_mailbox');
  class Statement {
    values: SQLInputValue[] = [];
    constructor(readonly sql: string) {}
    bind(...values: SQLInputValue[]) {
      if (values.length > 100) throw new Error('D1 allows at most 100 bound parameters');
      this.values = values; return this;
    }
    async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values), success: true, meta: { changes: 0, size_after: 4096 } }; }
    async run() { const result = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
  sqlite.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES ('u','employee@example.com','Employee','h','employee');`);
  if (!fresh) sqlite.exec(`INSERT INTO folders(id,user_id,name,type) VALUES ('in','u','Inbox','inbox'),('sent','u','Sent','sent'),('trash','u','Trash','trash'),('archive','u','Archive','archive'),('drafts','u','Drafts','drafts');`);
  function email(id: string, folder = 'in', thread = id, date = '2020-01-01T00:00:00.000Z') {
    sqlite.prepare(`INSERT INTO emails(id,thread_id,folder_id,user_id,sender,subject,snippet,r2_body_key,received_at,trashed_at)
      VALUES (?,?,?,'u','sender@example.com','Test','searchable','body',?,?)`).run(id, thread, folder, date, date);
    sqlite.prepare("INSERT INTO emails_fts(email_id,user_id,subject,sender,snippet) VALUES (?,'u','Test','sender@example.com','searchable')").run(id);
  }
  return { sqlite, db, email };
}
