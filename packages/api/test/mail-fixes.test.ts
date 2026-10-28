import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { MAX_ATTACHMENT_SIZE } from '@email-service/shared';
import { testDatabase } from './helpers/database';
import { largeUploadRoutes } from '../src/routes/large-uploads';
import { attachmentRoutes } from '../src/routes/attachments';
import { isMailboxQuery } from '../src/services/mailbox-storage';
import { withSignature, withSignatureText } from '../src/services/email-sender';
import type { Env, HonoVariables } from '../src/types';

function app(routes: Hono<{ Bindings: Env; Variables: HonoVariables }>) {
  const a = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  a.use('*', async (c, next) => { c.set('userId', 'u'); await next(); });
  a.route('/', routes);
  return a;
}

describe('mail storage and API fixes', () => {
  it('cancels a large upload on a fresh-schema install, which has no central email_shared_files', async () => {
    const f = testDatabase(true);
    const multipart = { uploadId: 'mp', abort: vi.fn(async () => undefined) };
    const env = { DB: f.db, APP_URL: 'https://mail.example.com', EMAIL_BUCKET: {
      createMultipartUpload: vi.fn(async () => multipart), resumeMultipartUpload: () => multipart, delete: vi.fn(async () => undefined) } } as unknown as Env;
    const a = app(largeUploadRoutes);
    const started = await a.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'big.bin', size: 1 }) }, env);
    const { data: { shareId } } = await started.json() as { data: { shareId: string } };
    const cancelled = await a.request(`/${shareId}`, { method: 'DELETE' }, env);
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(multipart.abort).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT * FROM shared_files').all()).toEqual([]);
    f.sqlite.close();
  });

  it('rejects every mailbox query that mixes in a central table from schema/fresh.sql', () => {
    const sql = readFileSync(join(__dirname, '../schema/fresh.sql'), 'utf8');
    const central = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)/g)].map(m => m[1]);
    expect(central).toContain('mailbox_shared_pins');
    for (const table of central) {
      expect(() => isMailboxQuery(`SELECT * FROM emails e JOIN ${table} x ON x.user_id = e.user_id`), table).toThrow(/Cross-store/);
      expect(isMailboxQuery(`SELECT * FROM ${table}`), table).toBe(false);
    }
  });

  it('refuses an oversized compose upload before buffering it, and still accepts a normal one', async () => {
    const put = vi.fn(async () => ({}));
    const env = { EMAIL_BUCKET: { put } } as unknown as Env;
    const a = app(attachmentRoutes);
    const huge = await a.request('/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
      body: new Uint8Array(MAX_ATTACHMENT_SIZE + 128 * 1024) }, env);
    expect(huge.status).toBe(413);
    const form = new FormData(); form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const ok = await a.request('/upload', { method: 'POST', body: form }, env);
    expect(ok.status, await ok.clone().text()).toBe(201);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('adds the text signature only when the HTML signature was appended by the server', () => {
    const edited = '<p>Hi</p><div data-signature="true">Jane</div>';
    expect(withSignature(edited, '<p>Jane</p>')).toBe(edited);
    expect(withSignatureText('Hi\n\nJane', '<p>Jane</p>', edited)).toBe('Hi\n\nJane');
    expect(withSignatureText('Hi', '<p>Jane</p>', '<p>Hi</p>')).toBe('Hi\n\n--\nJane');
  });
});
