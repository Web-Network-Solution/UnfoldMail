import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { testDatabase } from './helpers/database';
import { adminRoutes } from '../src/routes/admin';
import { runCentralCleanup } from '../src/services/retention';
import type { Env, HonoVariables } from '../src/types';

describe('persistent shared download links', () => {
  it('migrates populated shared files without changing links or file metadata', () => {
    const db = new DatabaseSync(':memory:');
    const dir = join(__dirname, '../migrations');
    for (const name of readdirSync(dir).sort().filter(name => name < '0012')) {
      db.exec(readFileSync(join(dir, name), 'utf8'));
    }
    db.exec(`INSERT INTO users(id,email,display_name,password_hash) VALUES ('u','u@example.com','User','hash');
      INSERT INTO shared_files(id,user_id,filename,size,r2_key,expires_at)
      VALUES ('share','u','report.pdf',123,'shared-files/share/report.pdf','2020-01-01T00:00:00Z');`);
    const before = db.prepare('SELECT * FROM shared_files').all();
    db.exec('BEGIN');
    db.exec(readFileSync(join(dir, '0012_preserve_shared_files.sql'), 'utf8'));
    db.exec('COMMIT');
    expect(db.prepare('SELECT * FROM shared_files').all()).toEqual(before);
    db.exec("DELETE FROM users WHERE id='u'");
    expect(db.prepare('SELECT * FROM shared_files').all()).toEqual(before.map(row => ({ ...row, user_id: null })));
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('account deletion preserves shared download lookup and does not delete shared R2 objects', async () => {
    const { sqlite, db, email } = testDatabase();
    email('mail');
    sqlite.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES ('boss','boss@example.com','Admin','hash','super_admin');
      INSERT INTO shared_files(id,user_id,filename,size,r2_key)
      VALUES ('share','u','file.pdf',123,'shared-files/share/file.pdf');`);
    const sharedKey = 'shared-files/share/file.pdf';
    const objects = new Set([sharedKey, 'emails/u/mail/body.html', 'attachments/u/mail/file.pdf']);
    const bucket = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false,
      })),
      delete: vi.fn(async (keys: string[]) => { for (const key of keys) objects.delete(key); }),
    };
    const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
    app.use('*', async (c, next) => { c.set('userRole', 'super_admin'); c.set('userId', 'boss'); await next(); });
    app.route('/admin', adminRoutes);
    const response = await app.request('/admin/users/u', { method: 'DELETE' }, { DB: db, EMAIL_BUCKET: bucket, MAILBOXES:{idFromName:(id:string)=>id,get:()=>({destroyDeletedAccount:async()=>{}})} } as unknown as Env);
    expect(response.status).toBe(200);
    expect(sqlite.prepare("SELECT id FROM users WHERE id='u'").get()).toBeUndefined();
    // The public download handler resolves by share ID, independently of the uploader.
    expect(sqlite.prepare("SELECT r2_key, user_id FROM shared_files WHERE id='share'").get()).toEqual({ r2_key: sharedKey, user_id: null });
    expect(objects).toEqual(new Set([sharedKey]));
    sqlite.close();
  });

  it('cleanup ignores shared-file legacy expiry dates and removes only abandoned staging', async () => {
    const { sqlite, db } = testDatabase();
    sqlite.exec(`INSERT INTO shared_files(id,user_id,filename,size,r2_key,expires_at)
      VALUES ('share','u','file.pdf',123,'shared-files/share/file.pdf','2000-01-01T00:00:00Z');`);
    const remove = vi.fn(async () => undefined);
    const list = vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [{ key: prefix + 'abandoned', uploaded: new Date('2000-01-01') }], truncated: false,
    }));
    await runCentralCleanup({ DB: db, EMAIL_BUCKET: { list, delete: remove } } as unknown as Env);
    expect(sqlite.prepare("SELECT id FROM shared_files WHERE id='share'").get()).toEqual({ id: 'share' });
    expect(list.mock.calls.map(([arg]) => arg.prefix)).toEqual(['inbound/', 'uploads/']);
    expect(remove).toHaveBeenCalledTimes(2);
    sqlite.close();
  });
});
