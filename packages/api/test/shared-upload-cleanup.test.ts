import { describe, expect, it, vi } from 'vitest';
import { testDatabase } from './helpers/database';
import { cleanupSharedUploads, retainSharedFiles, sharedFileStatements, sharedLinkIds } from '../src/services/shared-files';
import type { Env } from '../src/types';

function fixture() {
  const f = testDatabase();
  const remove = vi.fn(async (_key: string) => undefined);
  const env = { DB: f.db, APP_URL: 'https://mail.example.com', EMAIL_BUCKET: { delete: remove } } as unknown as Env;
  function upload(id: string, lifecycle = 'staged', date = '2000-01-01T00:00:00.000Z') {
    f.sqlite.prepare('INSERT INTO shared_files(id,user_id,filename,size,r2_key,lifecycle,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'u', 'file.pdf', 123, `shared-files/${id}/file.pdf`, lifecycle, date);
  }
  return { ...f, env, remove, upload };
}

describe('abandoned large-file uploads', () => {
  it('deletes only old staged uploads, preserving legacy, retained and recent files', async () => {
    const f = fixture();
    f.upload('abandoned'); f.upload('sent', 'retained'); f.upload('recent', 'staged', new Date().toISOString());
    f.sqlite.exec("INSERT INTO shared_files(id,user_id,filename,size,r2_key) VALUES ('legacy','u','file',1,'legacy-file')");
    expect(await cleanupSharedUploads(f.env)).toBe(1);
    expect(f.remove).toHaveBeenCalledWith('shared-files/abandoned/file.pdf');
    expect(f.sqlite.prepare('SELECT id FROM shared_files ORDER BY id').all()).toEqual([{ id: 'legacy' }, { id: 'recent' }, { id: 'sent' }]);
    f.sqlite.close();
  });

  it('protects saved drafts until mailbox maintenance releases removed-link pins', async () => {
    const f = fixture(); f.upload('draft-file'); f.email('draft', 'drafts');
    await f.db.batch(await sharedFileStatements(f.env, 'draft', 'u', '<a href="https://mail.example.com/api/shared/draft-file">File</a>', ''));
    expect(await cleanupSharedUploads(f.env)).toBe(0);
    await f.db.batch(await sharedFileStatements(f.env, 'draft', 'u', 'Link removed', ''));
    expect(await cleanupSharedUploads(f.env)).toBe(0);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM email_shared_files').get()).toEqual({n:0});
    f.sqlite.close();
  });

  it('keeps queued shared files after deleting the email and uploader account', async () => {
    const f = fixture(); f.upload('sent-file'); f.email('mail', 'sent');
    await f.db.batch(await sharedFileStatements(f.env, 'mail', 'u', '', 'https://mail.example.com/api/shared/sent-file'));
    await retainSharedFiles(f.env, '', 'https://mail.example.com/api/shared/sent-file');
    f.sqlite.exec("DELETE FROM emails WHERE id='mail'; DELETE FROM users WHERE id='u'");
    expect(await cleanupSharedUploads(f.env)).toBe(0);
    expect(f.sqlite.prepare('SELECT lifecycle,user_id FROM shared_files').get()).toEqual({ lifecycle: 'retained', user_id: null });
    f.sqlite.close();
  });

  it('retries storage deletion failures without losing the cleanup record', async () => {
    const f = fixture(); f.upload('abandoned');
    f.remove.mockRejectedValueOnce(new Error('R2 unavailable'));
    expect(await cleanupSharedUploads(f.env)).toBe(0);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({ lifecycle: 'deleting' });
    expect(await cleanupSharedUploads(f.env)).toBe(1);
    expect(f.sqlite.prepare('SELECT * FROM shared_files').all()).toEqual([]);
    f.sqlite.close();
  });

  it('rejects draft/send references if cleanup claimed the file after validation', async () => {
    const f = fixture(); f.upload('race'); f.email('mail');
    const statements = await sharedFileStatements(f.env, 'mail', 'u', '/api/shared/race', '');
    f.sqlite.exec("UPDATE shared_files SET lifecycle='deleting' WHERE id='race'");
    await expect(f.db.batch(statements)).rejects.toThrow('Shared upload is unavailable');
    expect(f.sqlite.prepare('SELECT * FROM email_shared_files').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({ lifecycle: 'deleting' });
    f.sqlite.close();
  });

  it('refuses another account’s staged upload but permits retained links', async () => {
    const f = fixture(); f.upload('private-stage');
    await expect(sharedFileStatements(f.env, 'mail', 'other', '/api/shared/private-stage', '')).rejects.toThrow('owner');
    f.sqlite.exec("INSERT INTO users(id,email,display_name,password_hash) VALUES('other','other@example.com','Other','h'); UPDATE shared_files SET lifecycle='retained' WHERE id='private-stage'");
    await expect(sharedFileStatements(f.env, 'mail', 'other', '/api/shared/private-stage', '')).resolves.toHaveLength(2);
    f.sqlite.close();
  });

  it('finds links in HTML and text, deduplicating IDs and ignoring unrelated hosts', () => {
    expect(sharedLinkIds('<a href="https://mail.example.com/api/shared/one">file</a> https://mail.example.com/api/shared/one /api/shared/two https://other.example/api/shared/foreign http://[bad', 'https://mail.example.com')).toEqual(['one', 'two']);
  });
});
