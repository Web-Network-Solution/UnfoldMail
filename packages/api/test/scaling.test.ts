import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { testDatabase } from './helpers/database';
import { runRetentionJob } from '../src/services/retention';
import { dispatchOutbox, processOutbound } from '../src/services/outbox';
import { emailRoutes } from '../src/routes/emails';
import type { Env, HonoVariables } from '../src/types';
import { encodedMessageBytes, MAX_OUTBOUND_MESSAGE_SIZE } from '@email-service/shared';

function fixture() {
  const database = testDatabase();
  const bucket = {
    get: vi.fn(async () => ({ text: async () => 'hello', arrayBuffer: async () => new ArrayBuffer(0) })),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
  };
  const send = vi.fn(async () => ({ messageId: 'provider-message-id' }));
  const publish = vi.fn(async () => undefined);
  const env = { MAILBOX_USER_ID: 'u', DB: database.db, EMAIL_BUCKET: bucket, ENVIRONMENT: 'production', EMAIL_DOMAIN: 'example.com', APP_URL: 'https://mail.example.com',
    SEND_EMAIL: { send }, OUTBOUND_QUEUE: { send: publish, sendBatch: publish },
    WEBSOCKET_HUB: { idFromName: () => 'u', get: () => ({ fetch: async () => new Response('{}') }) },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use('*', async (c, next) => { c.set('userId', 'u'); c.set('userEmail', 'employee@example.com'); await next(); });
  app.route('/emails', emailRoutes);
  return { ...database, bucket, send, publish, env, app };
}

afterEach(() => vi.useRealTimers());

describe('retention at employee scale', () => {
  it('drains more than 2,000 eligible messages over bounded runs without exceeding D1 bindings', async () => {
    const f = fixture();
    for (let i = 0; i < 2050; i++) f.email(`trash-${i}`, 'trash');
    f.email('keep-archive');
    f.email('recent-trash', 'trash', 'recent', new Date().toISOString());
    const first = await runRetentionJob(f.env);
    expect(first.deleted).toBe(1800);
    expect(first.remainingTrash).toBe(250);
    const next = await runRetentionJob(f.env);
    expect(next.deleted).toBe(250);
    expect(next.remainingTrash).toBe(0);
    expect(f.sqlite.prepare("SELECT folder_id FROM emails WHERE id = 'keep-archive'").get()).toEqual({ folder_id: 'archive' });
    expect(f.sqlite.prepare("SELECT email_id FROM emails_fts WHERE emails_fts MATCH 'searchable' AND email_id = 'keep-archive'").get()).toBeTruthy();
    expect(f.sqlite.prepare("SELECT id FROM emails WHERE id = 'recent-trash'").get()).toBeTruthy();
    expect(f.sqlite.prepare("SELECT email_id FROM emails_fts WHERE email_id = 'trash-1'").get()).toBeUndefined();
    f.sqlite.close();
  });

  it('keeps summaries correct when mail is read, moved, updated and deleted', () => {
    const f = fixture();
    f.email('one', 'in', 'thread'); f.email('two', 'in', 'thread', '2021-01-01T00:00:00.000Z');
    expect(f.sqlite.prepare('SELECT message_count, unread_count, latest_email_id FROM mailbox_threads').get()).toEqual({ message_count: 2, unread_count: 2, latest_email_id: 'two' });
    f.sqlite.exec("UPDATE emails SET is_read=1 WHERE id='two'; UPDATE emails SET folder_id='archive' WHERE id='one'; DELETE FROM emails WHERE id='two';");
    expect(f.sqlite.prepare('SELECT folder_id, message_count, latest_email_id FROM mailbox_threads').all()).toEqual([{ folder_id: 'archive', message_count: 1, latest_email_id: 'one' }]);
    f.sqlite.close();
  });

  it('preserves user deletion with summary and outbox foreign keys enabled', () => {
    const f = fixture();
    f.email('one', 'in', 'thread'); f.email('two', 'in', 'thread');
    f.sqlite.exec("DELETE FROM users WHERE id='u'");
    expect(f.sqlite.prepare('SELECT * FROM mailbox_threads').all()).toEqual([]);
    f.sqlite.close();
  });
});

describe('durable outbound delivery', () => {
  it('protects a saved shared-file draft and retains its file when queued for sending', async () => {
    const f = fixture();
    f.sqlite.exec("INSERT INTO shared_files(id,user_id,filename,size,r2_key,lifecycle,created_at) VALUES ('large','u','file.pdf',123,'shared-files/large/file.pdf','staged','2000-01-01T00:00:00.000Z')");
    const message = { to: ['other@example.com'], subject: 'Large file', bodyHtml: '<a href="https://mail.example.com/api/shared/large">Download</a>', bodyText: 'https://mail.example.com/api/shared/large' };
    const draftResponse = await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...message, isDraft: true }) }, f.env);
    expect(draftResponse.status).toBe(200);
    const draft = await draftResponse.json() as { data: { emailId: string } };
    expect((await runRetentionJob(f.env)).abandonedSharedRemoved).toBe(0);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({ lifecycle: 'staged' });
    const sentResponse = await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...message, draftId: draft.data.emailId }) }, f.env);
    expect(sentResponse.status).toBe(200);
    const sent = await sentResponse.json() as { data: { emailId: string } };
    expect(f.sqlite.prepare('SELECT email_id,share_id FROM email_shared_files').all()).toEqual([{ email_id: sent.data.emailId, share_id: 'large' }]);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({ lifecycle: 'retained' });
    expect(f.sqlite.prepare('SELECT id FROM emails WHERE id=?').get(draft.data.emailId)).toBeUndefined();
    f.sqlite.close();
  });

  async function queued() {
    const f = fixture();
    const response = await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ['other@example.com'], subject: 'Hello', bodyHtml: '<p>Hello</p>', bodyText: 'Hello' }) }, f.env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { emailId: string; deliveryStatus: string } };
    expect(body.data.deliveryStatus).toBe('queued');
    expect(f.send).not.toHaveBeenCalled();
    return { ...f, job: { kind: 'outbound' as const, userId:'u', emailId: body.data.emailId } };
  }
  it('persists before sending and ignores duplicate queue delivery after success', async () => {
    const f = await queued();
    await processOutbound(f.job, f.env);
    await processOutbound(f.job, f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT delivery_status, message_id FROM emails').get()).toEqual({ delivery_status: 'sent', message_id: 'provider-message-id' });
    f.sqlite.close();
  });
  it('backs off quota rejections, then sends from the saved message', async () => {
    const f = await queued();
    f.send.mockRejectedValueOnce(Object.assign(new Error('Quota reached'), { code: 'E_DAILY_LIMIT_EXCEEDED' }));
    await processOutbound(f.job, f.env);
    await processOutbound(f.job, f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT status FROM outbound_jobs').get()).toEqual({ status: 'queued' });
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3_601_000);
    await dispatchOutbox(f.env);
    await processOutbound(f.job, f.env);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.sqlite.prepare('SELECT delivery_status FROM emails').get()).toEqual({ delivery_status: 'sent' });
    f.sqlite.close();
  });
  it('does not automatically resend when delivery is ambiguous', async () => {
    const f = await queued();
    f.send.mockRejectedValueOnce(new Error('Connection lost after submission'));
    await processOutbound(f.job, f.env); await processOutbound(f.job, f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT status FROM outbound_jobs').get()).toEqual({ status: 'uncertain' });
    const retry = await f.app.request(`/emails/${f.job.emailId}/retry`, { method: 'POST' }, f.env);
    expect(retry.status).toBe(409);
    f.sqlite.close();
  });
  it('recovers saved jobs even when their initial queue publication was lost', async () => {
    const f = fixture(); f.publish.mockRejectedValueOnce(new Error('Queue temporarily down'));
    const response = await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ['other@example.com'], subject: 'Hello' }) }, f.env);
    expect(response.status).toBe(200);
    await dispatchOutbox(f.env);
    expect(f.publish).toHaveBeenCalledTimes(2);
    f.sqlite.close();
  });

  it('deduplicates HTTP retries and makes a sent draft immutable', async () => {
    const f = fixture(); f.email('draft', 'drafts');
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'retry-safe-request-123', draftId: 'draft', to: ['other@example.com'], subject: 'Hello' }) };
    const first = await f.app.request('/emails/send', request, f.env);
    const second = await f.app.request('/emails/send', request, f.env);
    const a = await first.json() as { data: { emailId: string } };
    const b = await second.json() as { data: { emailId: string } };
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(a.data.emailId).toBe(b.data.emailId); expect(a.data.emailId).not.toBe('draft');
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM outbound_jobs').get()).toEqual({ n: 1 });
    expect(f.sqlite.prepare("SELECT id FROM emails WHERE id='draft'").get()).toBeUndefined();
    const deletion = await f.app.request(`/emails/${a.data.emailId}?permanent=true`, { method: 'DELETE' }, f.env);
    expect(deletion.status).toBe(409);
    f.sqlite.close();
  });

  it('requires explicit resolution of interrupted submissions before retrying', async () => {
    const f = await queued();
    f.sqlite.exec("UPDATE outbound_jobs SET status='sending',updated_at='2020-01-01T00:00:00.000Z'");
    await dispatchOutbox(f.env);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT delivery_status FROM emails').get()).toEqual({ delivery_status: 'uncertain' });
    const resolved = await f.app.request(`/emails/${f.job.emailId}/resolve-delivery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'not_delivered' }) }, f.env);
    expect(resolved.status).toBe(200);
    const retry = await f.app.request(`/emails/${f.job.emailId}/retry`, { method: 'POST' }, f.env);
    expect(retry.status).toBe(200);
    await processOutbound(f.job, f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.sqlite.close();
  });

  it('retains linked shared files before the provider call, and requeues unsent when it cannot', async () => {
    const f = fixture();
    const link = 'https://mail.example.com/api/shared/large';
    f.sqlite.exec(`INSERT INTO shared_files(id,user_id,filename,size,r2_key,lifecycle,created_at) VALUES ('large','u','file.pdf',123,'shared-files/large/file.pdf','staged','2000-01-01T00:00:00.000Z');
      CREATE TRIGGER retain_down BEFORE UPDATE OF lifecycle ON shared_files WHEN NEW.lifecycle='retained' BEGIN SELECT RAISE(ABORT,'central store unavailable'); END;`);
    f.bucket.get.mockImplementation(async () => ({ text: async () => link, arrayBuffer: async () => new ArrayBuffer(0) }));
    const response = await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ['other@example.com'], subject: 'File', bodyHtml: link, bodyText: link }) }, f.env);
    expect(response.status).toBe(200); // the post-commit retain is best-effort
    const job = { kind: 'outbound' as const, userId: 'u', emailId: ((await response.json()) as { data: { emailId: string } }).data.emailId };
    await processOutbound(job, f.env);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT status FROM outbound_jobs').get()).toEqual({ status: 'queued' });
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({ lifecycle: 'staged' });
    f.sqlite.exec("DROP TRIGGER retain_down; UPDATE outbound_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z'");
    await processOutbound(job, f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({ lifecycle: 'retained' });
    f.sqlite.close();
  });

  it('rejects wrongly typed send fields with 400 instead of a 500 or a silent draft', async () => {
    const f = fixture();
    const send = (extra: object) => f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ['other@example.com'], subject: 'Hi', ...extra }) }, f.env);
    for (const bad of [{ bodyHtml: 123 }, { bodyText: ['x'] }, { subject: { a: 1 } }, { attachmentKeys: [1] }, { forwardAttachmentIds: 'x' }, { inReplyTo: {} }, { draftId: 7 }, { isDraft: 'false' }]) {
      expect((await send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' }, f.env)).status).toBe(400);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({ n: 0 });
    // null means omitted: the AI tools send inReplyTo:null for a parent without a Message-ID.
    expect((await send({ inReplyTo: null, draftId: null, isDraft: false })).status).toBe(200);
    f.sqlite.close();
  });

  it('deletes permanently only from Trash', async () => {
    const f = fixture(); f.email('m');
    const purge = () => f.app.request('/emails/m?permanent=true', { method: 'DELETE' }, f.env);
    expect((await purge()).status).toBe(409);
    expect(f.sqlite.prepare("SELECT folder_id FROM emails WHERE id='m'").get()).toEqual({ folder_id: 'in' });
    expect((await f.app.request('/emails/m', { method: 'DELETE' }, f.env)).status).toBe(200);
    expect((await purge()).status).toBe(200);
    expect(f.sqlite.prepare("SELECT id FROM emails WHERE id='m'").get()).toBeUndefined();
    f.sqlite.close();
  });
});

describe('conversation pagination and message limits', () => {
  it('lists the latest subject and unread counts from summaries across folders', async () => {
    const f = fixture();
    f.email('one', 'in', 'thread'); f.email('two', 'sent', 'thread', '2026-01-01T00:00:00.000Z');
    f.sqlite.exec("UPDATE emails SET subject='Latest subject',is_read=1 WHERE id='two'");
    const response = await f.app.request('/emails/threads', {}, f.env);
    const result = await response.json() as { data: { subject: string; unreadCount: number; messageCount: number }[] };
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ subject: 'Latest subject', unreadCount: 1, messageCount: 2 });
    f.sqlite.close();
  });
  it('makes all 130 messages reachable without fetching R2 bodies for collapsed messages', async () => {
    const f = fixture();
    for (let i = 0; i < 130; i++) f.email(String(i).padStart(4, '0'), 'in', 'long-thread');
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const response = await f.app.request(`/emails/threads/long-thread${cursor ? '?before=' + cursor : ''}`, {}, f.env);
      const body = await response.json() as { data: { emails: { id: string }[]; nextCursor?: string } };
      ids.push(...body.data.emails.map(e => e.id)); cursor = body.data.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(130); expect(new Set(ids).size).toBe(130);
    expect(f.bucket.get).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT SUM(is_read) AS n FROM emails').get()).toEqual({ n: 0 });
    f.sqlite.close();
  });
  it('rejects oversized encoded bodies before queueing or calling the sender', async () => {
    const f = fixture();
    expect(encodedMessageBytes(4 * 1024 * 1024)).toBeGreaterThan(MAX_OUTBOUND_MESSAGE_SIZE);
    const response = await f.app.request('/emails/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: ['other@example.com'], bodyText: 'x'.repeat(4 * 1024 * 1024) }) }, f.env);
    expect(response.status).toBe(413); expect(f.publish).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    f.sqlite.close();
  });
});
