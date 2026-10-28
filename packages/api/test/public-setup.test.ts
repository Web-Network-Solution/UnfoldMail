import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { authRoutes as auth } from '../src/routes/auth';
import { testDatabase } from './helpers/database';
import type { Env } from '../src/types';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function fixture(secret: string | undefined = 'a'.repeat(64)) {
  const { db, sqlite } = testDatabase(true);
  sqlite.exec('DELETE FROM users; DELETE FROM mailbox_routes;');
  const env = { DB: db, EMAIL_DOMAIN: 'example.com', APP_URL: 'https://mail.example.com', BOOTSTRAP_SECRET: secret } as unknown as Env;
  const app = new Hono();
  app.route('/auth', auth);
  const call = (body: unknown) => app.request('/auth/bootstrap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, env);
  const body = { email: 'admin@example.com', displayName: 'Admin', password: 'long-enough-password', bootstrapSecret: 'a'.repeat(64) };
  return { sqlite, call, body };
}

describe('public installation ownership', () => {
  it('fails closed without a sufficiently long configured secret', async () => {
    const f = fixture('short');
    expect((await f.call(f.body)).status).toBe(503);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(0);
    f.sqlite.close();
  });
  it('rejects invalid secrets and throttles repeated guesses', async () => {
    const f = fixture();
    expect((await f.call({ ...f.body, bootstrapSecret: 'wrong' })).status).toBe(403);
    f.sqlite.exec('UPDATE login_attempts SET failed_count=999');
    expect((await f.call(f.body)).status).toBe(429);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(0);
    f.sqlite.close();
  });
  it('requires an address on the configured domain and rejects malformed fields', async () => {
    const f = fixture();
    expect((await f.call({ ...f.body, email: 'admin@another.example' })).status).toBe(400);
    expect((await f.call({ ...f.body, displayName: {} })).status).toBe(400);
    f.sqlite.close();
  });
  it('creates one administrator and refuses any subsequent setup', async () => {
    const f = fixture();
    expect((await f.call(f.body)).status).toBe(201);
    expect(f.sqlite.prepare('SELECT email,role FROM users').get()).toEqual({ email: 'admin@example.com', role: 'super_admin' });
    expect((await f.call(f.body)).status).toBe(409);
    f.sqlite.close();
  });
});

describe('public migration chain', () => {
  const dir = join(__dirname, '../../../deployment/migrations');
  const files = readdirSync(dir).sort();
  it('initializes a fresh database and preserves existing rows through later migrations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(join(dir, files[0]), 'utf8'));
    db.exec("INSERT INTO users(id,email,display_name,password_hash) VALUES ('test','test@example.com','Original','hash')");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const snapshots = tables.map(t => ({ name: String(t.name), rows: db.prepare(`SELECT * FROM "${t.name}"`).all() }));
    for (const file of files.slice(1)) db.exec(readFileSync(join(dir, file), 'utf8'));
    for (const snapshot of snapshots) expect(db.prepare(`SELECT * FROM "${snapshot.name}"`).all()).toEqual(snapshot.rows);
    expect(() => db.exec(readFileSync(join(dir, files[0]), 'utf8'))).toThrow();
    expect(db.prepare('SELECT display_name FROM users').get()?.display_name).toBe('Original');
    db.close();
  });
});
