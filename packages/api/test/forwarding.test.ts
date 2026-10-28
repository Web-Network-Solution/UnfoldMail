import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ForwardingConfig, MailFilter } from '@email-service/shared';
import type { Env, HonoVariables, SendEmailMessage } from '../src/types';
import { testDatabase } from './helpers/database';
import { evaluateFilters, matchesFilter, destinationAllowed } from '../src/services/mail-filters';
import { forwardingRoutes, forwardingAdminRoutes } from '../src/routes/forwarding';
import { prepareForwarding, processForwarding, dispatchForwarding, cleanupForwarding, cleanupForwardingSnapshots } from '../src/services/forwarding';
import { processInboundEmail } from '../src/services/email-processor';
import { emailBodyTextKey } from '../src/lib/utils';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const rule = (patch: Partial<MailFilter> = {}): MailFilter => ({ id: 'r1', name: 'Invoices', enabled: true, match: 'all', conditions: { subject: 'invoice' }, actions: { forwardTo: ['accounts@other.test'], star: true }, stop: false, ...patch });
const config = (): ForwardingConfig => ({ revision: 0, destinations: ['accounts@other.test'], forwardAll: null, rules: [rule()] });
const mail = { from: 'billing@vendor.test', to: ['employee@example.com'], subject: 'INVOICE 123', text: 'Payment due', hasAttachments: true, size: 4096 };
const fixtures: ReturnType<typeof testDatabase>[] = [];
function fixture() {
  const database = testDatabase(); fixtures.push(database);
  const objects = new Map<string, { data: Uint8Array; uploaded: Date }>();
  const bucket = {
    put: vi.fn(async (key: string, value: string | ArrayBuffer | ReadableStream | Uint8Array) => {
      const data = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { data, uploaded: new Date() });
    }),
    get: vi.fn(async (key: string) => {
      const o = objects.get(key); if (!o) return null;
      return { size: o.data.byteLength, body: new Response(o.data).body, text: async () => new TextDecoder().decode(o.data), arrayBuffer: async () => o.data.buffer.slice(o.data.byteOffset, o.data.byteOffset + o.data.byteLength) };
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })), truncated: false })),
  };
  const send = vi.fn(async (_message: SendEmailMessage) => ({ messageId: 'sent-id' }));
  const publish = vi.fn(async (_messages: unknown) => undefined);
  const env = { MAILBOX_USER_ID: 'u', DB: database.db, EMAIL_BUCKET: bucket, SEND_EMAIL: { send }, OUTBOUND_QUEUE: { sendBatch: publish }, EMAIL_DOMAIN: 'example.com', APP_URL: 'https://mail.example.com', WEBSOCKET_HUB: { idFromName: () => 'u', get: () => ({ fetch: async () => new Response('{}') }) } } as unknown as Env;
  let user = 'u', role: HonoVariables['userRole'] = 'employee';
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use('*', async (c, next) => { c.set('userId', user); c.set('userEmail', 'employee@example.com'); c.set('userRole', role); await next(); });
  app.route('/forwarding', forwardingRoutes); app.route('/admin/forwarding', forwardingAdminRoutes);
  const request = (path: string, method = 'GET', data?: unknown) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, env);
  async function save(value = config()) { return request('/forwarding', 'PUT', value); }
  async function prepare(options: { blockForwarding?: boolean; bytes?: number; id?: string } = {}) {
    const id = options.id || 'incoming'; database.email(id);
    const prepared = await prepareForwarding(env, { emailId: id, userId: 'u', userEmail: 'employee@example.com', inboxFolderId: 'in', message: mail,
      html: '<p>Invoice</p>', text: 'Invoice', replyTo: 'reply@vendor.test', blockForwarding: !!options.blockForwarding,
      attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', content: new Uint8Array(options.bytes || 3).buffer, disposition: 'attachment' }] });
    await database.db.batch(prepared.statements); return prepared;
  }
  return { ...database, objects, bucket, send, publish, env, request, save, prepare, asUser: (id: string) => { user = id; }, asRole: (r: HonoVariables['userRole']) => { role = r; } };
}
afterEach(() => { for (const f of fixtures.splice(0)) f.sqlite.close(); vi.useRealTimers(); });

describe('filter semantics', () => {
  it('matches case-insensitive addresses/domains, phrases, attachment absence and inclusive size bounds', () => {
    expect(matchesFilter(rule({ conditions: { from: 'BILLING@VENDOR.TEST', fromDomain: 'vendor.test', to: 'EMPLOYEE@EXAMPLE.COM', subject: 'invoice', contains: 'payment due', excludes: 'overdue', hasAttachments: true, minBytes: 4096, maxBytes: 4096 } }), mail)).toBe(true);
    expect(matchesFilter(rule({ conditions: { hasAttachments: false } }), mail)).toBe(false);
    expect(matchesFilter(rule({ match: 'any', conditions: { from: 'someone@other.test', hasAttachments: true } }), mail)).toBe(true);
    expect(matchesFilter(rule({ conditions: {} }), mail)).toBe(true);
  });
  it('deduplicates destinations, follows ordering and honors stop without disabling global forwarding', () => {
    const c = config(); c.forwardAll = 'accounts@other.test';
    c.rules = [rule({ actions: { archive: true, forwardTo: ['accounts@other.test'] } }), rule({ id: 'r2', stop: true, actions: { folderId: 'custom', markRead: true } }), rule({ id: 'r3', actions: { star: true } })];
    expect(evaluateFilters(c, mail)).toEqual({ destinations: ['accounts@other.test'], folderId: 'custom', archive: false, markRead: true, star: false });
  });
  it('enforces exact admin domain restrictions and prevents self forwarding', () => {
    const p = { enabled: true, allowExternal: false, allowedDomains: [] };
    expect(destinationAllowed('u@outside.test', 'a@example.com', 'example.com', p)).toBe(false);
    expect(destinationAllowed('a@example.com', 'a@example.com', 'example.com', p)).toBe(false);
    expect(destinationAllowed('u@sub.example.com', 'a@example.com', 'example.com', { ...p, allowExternal: true, allowedDomains: ['example.com'] })).toBe(false);
  });
});

describe('forwarding configuration API', () => {
  it('applies the additive migration to a populated previous schema without changing mail', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const dir = join(__dirname, '../migrations');
      for (const file of readdirSync(dir).sort().filter(f => f < '0016')) db.exec(readFileSync(join(dir, file), 'utf8'));
      db.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES('existing','owner@example.com','Owner','h','employee');
        INSERT INTO folders(id,user_id,name,type) VALUES('existing-in','existing','Inbox','inbox');
        INSERT INTO emails(id,thread_id,folder_id,user_id,sender,r2_body_key) VALUES('existing-mail','t','existing-in','existing','sender@example.com','existing-key');`);
      const before = db.prepare('SELECT * FROM emails').all();
      db.exec(readFileSync(join(dir, '0016_forwarding_filters.sql'), 'utf8'));
      expect(db.prepare('SELECT * FROM emails').all()).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });
  it('saves without destination verification, rejects stale writes, and audits only committed changes', async () => {
    const f = fixture(); expect((await f.save()).status).toBe(200);
    expect((await f.save()).status).toBe(409);
    expect((await f.save({ ...config(), revision: 1, forwardAll: 'accounts@other.test' })).status).toBe(200);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM forwarding_audit').get()?.n).toBe(2);
    expect(f.sqlite.prepare('SELECT revision FROM forwarding_configs').get()?.revision).toBe(2);
  });
  it('rejects foreign folders, self destinations and malformed conditions', async () => {
    const f = fixture();
    expect((await f.save({ ...config(), rules: [rule({ actions: { folderId: 'foreign' } })] })).status).toBe(400);
    expect((await f.save({ ...config(), destinations: ['employee@example.com'] })).status).toBe(400);
    expect((await f.save({ ...config(), rules: [rule({ conditions: { minBytes: -1 } })] })).status).toBe(400);
    expect((await f.request('/forwarding', 'PUT', { ...config(), rules: [{ ...rule(), conditions: { regex: 'x' } }] })).status).toBe(400);
  });
  it('limits policy/history to super-admin and enforces policy on save', async () => {
    const f = fixture(); expect((await f.request('/admin/forwarding')).status).toBe(403);
    f.asRole('admin'); expect((await f.request('/admin/forwarding/audit')).status).toBe(403);
    f.asRole('super_admin'); expect((await f.request('/admin/forwarding', 'PUT', { enabled: true, allowExternal: false, allowedDomains: [] })).status).toBe(200);
    expect((await f.save()).status).toBe(400);
  });
  it('never echoes an internal error message as a validation error', async () => {
    const f = fixture();
    Object.assign(f.db, { batch: async () => { throw new Error('mailbox shard 7 storage reset'); } });
    const response = await f.save();
    expect(response.status).toBe(500); expect(await response.text()).not.toContain('shard');
  });
  it('previews against the same body text inbound filtering uses', async () => {
    const f = fixture(); f.email('one'); f.email('two');
    await f.bucket.put(emailBodyTextKey('u', 'one', 'body'), 'Contact <billing@vendor.test>');
    await f.bucket.put('body', '<head><style>.x{color:red}</style></head><p>billing@vendor.test</p>');
    const matches = async (contains: string) => ((await (await f.request('/forwarding/preview', 'POST', rule({ conditions: { contains } }))).json()) as { data: { matches: unknown[] } }).data.matches.length;
    expect(await matches('billing@vendor.test')).toBe(2);
    expect(await matches('color')).toBe(0);
  });
  it('previews only owned incoming messages and never queues mail or changes flags', async () => {
    const f = fixture(); f.email('one'); f.email('sent-one', 'sent');
    const response = await f.request('/forwarding/preview', 'POST', rule({ conditions: {} }));
    const result = await response.json() as { data: { scanned: number; matches: unknown[] } };
    expect(result.data.scanned).toBe(1); expect(result.data.matches).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM forwarding_jobs').get()?.n).toBe(0);
    expect(f.sqlite.prepare("SELECT is_starred FROM emails WHERE id='one'").get()?.is_starred).toBe(0);
  });
});

describe('durable forwarding', () => {
  it.each(['Auto-Submitted: auto-generated', 'List-Unsubscribe: <mailto:unsubscribe@vendor.test>\r\nPrecedence: bulk'])('forwards matching transactional mail despite automated queue flag: %s', async header => {
    const f = fixture(); await f.save();
    const mime = `From: billing@vendor.test\r\nTo: employee@example.com\r\nSubject: Invoice\r\n${header}\r\nContent-Type: text/plain\r\n\r\nPayment due`;
    await f.bucket.put('raw-automated', mime);
    await processInboundEmail({ rawKey:'raw-automated', from:mail.from, to:'employee@example.com', rawSize:mime.length, receivedAt:new Date().toISOString(), automated:true }, f.env);
    const job = f.sqlite.prepare('SELECT id,status FROM forwarding_jobs').get()!;
    expect(job.status).toBe('queued');
    await processForwarding({kind:'forwarding',id:String(job.id),userId:'u'},f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('sent');
  });
  it.each([
    ['X-RWA-Auto-Forwarded: 1', 'billing@vendor.test'],
    ['Auto-Submitted: AUTO-REPLIED; owner-email=reply@vendor.test', 'billing@vendor.test'],
    ['', ''], ['', '<>'],
    ['Content-Type: multipart/report; report-type="delivery-status"', 'mailer-daemon@vendor.test'],
  ])('blocks loops, auto-replies and bounces even without the queue automated flag: %s', async (header, sender) => {
    const f=fixture(); await f.save();
    const mime=`From: billing@vendor.test\r\nTo: employee@example.com\r\nSubject: Invoice\r\n${header}\r\n\r\nPayment due`;
    await f.bucket.put('raw-blocked',mime);
    await processInboundEmail({rawKey:'raw-blocked',from:sender,to:'employee@example.com',rawSize:mime.length,receivedAt:new Date().toISOString()},f.env);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM forwarding_jobs').get()?.n).toBe(0);
    expect(f.sqlite.prepare('SELECT is_starred FROM emails').get()?.is_starred).toBe(1);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('applies filters and commits a job during real inbound processing; duplicate delivery is harmless', async () => {
    const f = fixture(); await f.save();
    const mime = 'From: billing@vendor.test\r\nTo: employee@example.com\r\nSubject: Invoice\r\nMessage-ID: <fixture@vendor.test>\r\nContent-Type: text/plain\r\n\r\nPayment due';
    await f.bucket.put('raw-one', mime);
    const message = { rawKey: 'raw-one', from: mail.from, to: 'employee@example.com', rawSize: mime.length, receivedAt: new Date().toISOString(), messageKey: '<fixture@vendor.test>' };
    await processInboundEmail(message, f.env);
    await f.bucket.put('raw-two', mime); await processInboundEmail({ ...message, rawKey: 'raw-two' }, f.env);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM forwarding_jobs').get()?.n).toBe(1);
    expect(f.sqlite.prepare('SELECT is_starred FROM emails').get()?.is_starred).toBe(1);
    expect(f.publish).toHaveBeenCalledTimes(1);
  });
  it('retains an independent attachment copy after deleting the original and sends once under duplicate workers', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare();
    f.sqlite.prepare("DELETE FROM emails WHERE id='incoming'").run();
    await Promise.all([processForwarding(prepared.jobs[0], f.env), processForwarding(prepared.jobs[0], f.env)]);
    expect(f.send).toHaveBeenCalledTimes(1);
    const sent = f.send.mock.calls[0][0]; expect(sent.replyTo).toBe('reply@vendor.test'); expect(sent.headers?.['X-RWA-Auto-Forwarded']).toBe('1');
    expect(sent.attachments?.[0].filename).toBe('invoice.pdf');
    expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('sent');
  });
  it('does not re-forward loop-blocked mail but still applies folder/read/star actions', async () => {
    const f = fixture(); await f.save({ ...config(), rules: [rule({ actions: { archive: true, markRead: true, star: true, forwardTo: ['accounts@other.test'] } })] });
    const prepared = await f.prepare({ blockForwarding: true }); expect(prepared.jobs).toHaveLength(0);
    expect(f.sqlite.prepare("SELECT folder_id,is_archived,is_read,is_starred FROM emails WHERE id='incoming'").get()).toEqual({ folder_id: 'archive', is_archived: 1, is_read: 1, is_starred: 1 });
  });
  it('converts large attachments into permanent shared copies surviving snapshot cleanup', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare({ bytes: 4 * 1024 * 1024 }); await processForwarding(prepared.jobs[0], f.env);
    expect(f.send.mock.calls[0][0].attachments).toBeUndefined();
    const share = f.sqlite.prepare('SELECT id,r2_key,lifecycle FROM shared_files').get()!;
    expect(f.send.mock.calls[0][0].text).toContain(`/api/shared/${share.id}`);
    expect(share.lifecycle).toBe('retained');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31 * 86400_000); await cleanupForwarding(f.env); await cleanupForwardingSnapshots({...f.env,MAILBOX_USER_ID:undefined});
    expect(f.objects.has(String(share.r2_key))).toBe(true); expect(f.objects.has(prepared.keys[0])).toBe(false);
    expect(f.sqlite.prepare('SELECT COUNT(*) n FROM forwarding_jobs').get()?.n).toBe(0);
  });
  it('rewrites each linked inline part at its exact cid token only', async () => {
    const f = fixture(); await f.save(); f.email('incoming');
    const inline = (contentId: string) => ({ filename: `${contentId}.png`, mimeType: 'image/png', content: new Uint8Array(3 * 1024 * 1024).buffer, contentId, disposition: 'inline' as const });
    const prepared = await prepareForwarding(f.env, { emailId: 'incoming', userId: 'u', userEmail: 'employee@example.com', inboxFolderId: 'in', message: mail,
      html: '<img src="cid:img1"><img src="cid:img10">', text: 'Invoice', blockForwarding: false, attachments: [inline('img1'), inline('img10')] });
    await f.db.batch(prepared.statements); await processForwarding(prepared.jobs[0], f.env);
    const url = (name: string) => `https://mail.example.com/api/shared/${f.sqlite.prepare('SELECT id FROM shared_files WHERE filename=?').get(name)!.id}`;
    const html = f.send.mock.calls[0][0].html!;
    expect(html).toContain(`<img src="${url('img1.png')}"><img src="${url('img10.png')}">`);
  });
  it('rechecks administrator restrictions and disabled forwarding before dispatch', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare();
    f.sqlite.prepare("INSERT INTO settings(key,value) VALUES('forwarding_policy',?)").run(JSON.stringify({ enabled: false, allowExternal: true, allowedDomains: [] }));
    await processForwarding(prepared.jobs[0], f.env); expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('failed');
  });
  it('logs bounded redacted diagnostics without resending an uncertain delivery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const f = fixture(); await f.save(); const prepared = await f.prepare();
      f.send.mockRejectedValueOnce(new Error('Invalid field "private value" for person@example.com 123456 https://example.com/private\n' + 'x'.repeat(400)));
      await processForwarding(prepared.jobs[0], f.env);
      const diagnostic = log.mock.calls.find(call => call[0] === 'forwarding_send_failed')?.[1];
      expect(diagnostic).toMatchObject({ jobId: prepared.jobs[0].id, attempt: 1, code: 'unknown' });
      expect(diagnostic.reason.length).toBeLessThanOrEqual(300);
      expect(diagnostic.reason).not.toMatch(/private|person@example|123456|https:|\n/);
      expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('uncertain');
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
  it('retries explicit temporary rejection but never automatically resends an uncertain provider call', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare();
    f.send.mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { code: 'E_RATE_LIMIT_EXCEEDED' }));
    await processForwarding(prepared.jobs[0], f.env); expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('queued');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120_000);
    f.send.mockRejectedValueOnce(new Error('Connection lost'));
    await processForwarding(prepared.jobs[0], f.env); await dispatchForwarding(f.env);
    expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('uncertain'); expect(f.publish).not.toHaveBeenCalled();
    expect((await f.request(`/forwarding/activity/${prepared.jobs[0].id}/retry`, 'POST')).status).toBe(409);
    expect((await f.request(`/forwarding/activity/${prepared.jobs[0].id}/retry`, 'POST', { acknowledgeDuplicate: true })).status).toBe(200);
  });
  it('recovers missed publication and marks interrupted sends uncertain', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare(); await dispatchForwarding(f.env);
    expect(f.publish).toHaveBeenCalledWith([{ body: prepared.jobs[0] }]);
    f.sqlite.prepare("UPDATE forwarding_jobs SET status='sending',updated_at='2000-01-01'").run();
    await dispatchForwarding(f.env); expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('uncertain');
  });
  it('preserves committed jobs and snapshots when inbound queue publication fails', async () => {
    const f = fixture(); await f.save();
    const mime = 'From: billing@vendor.test\r\nTo: employee@example.com\r\nSubject: Invoice\r\nContent-Type: text/plain\r\n\r\nPayment due';
    await f.bucket.put('raw', mime); f.publish.mockRejectedValueOnce(new Error('Queue unavailable'));
    await processInboundEmail({ rawKey: 'raw', from: mail.from, to: 'employee@example.com', rawSize: mime.length, receivedAt: new Date().toISOString() }, f.env);
    const saved = f.sqlite.prepare('SELECT snapshot_key,status FROM forwarding_jobs').get()!;
    expect(saved.status).toBe('queued'); expect(f.objects.has(String(saved.snapshot_key))).toBe(true);
    await dispatchForwarding(f.env); expect(f.publish).toHaveBeenCalledTimes(2);
  });
  it('cancels a queued delivery when its forwarding rule is disabled', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare();
    await f.save({ ...config(), revision: 1, rules: [rule({ enabled: false })] });
    await processForwarding(prepared.jobs[0], f.env); expect(f.send).not.toHaveBeenCalled();
    expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('cancelled');
  });
  it('retains failed snapshots for retry and cleans uncommitted orphan snapshots', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare();
    f.sqlite.prepare("UPDATE forwarding_jobs SET status='failed'").run();
    await f.bucket.put('forwarding/orphan/part-0', 'orphan');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 40 * 86400_000); await cleanupForwarding(f.env); await cleanupForwardingSnapshots({...f.env,MAILBOX_USER_ID:undefined});
    expect(f.objects.has(prepared.keys[0])).toBe(true);
    expect(f.objects.has('forwarding/orphan/part-0')).toBe(false);
  });
  it('protects activity mutations across accounts and cancels removed-account jobs', async () => {
    const f = fixture(); await f.save(); const prepared = await f.prepare(); f.asUser('other');
    expect((await f.request(`/forwarding/activity/${prepared.jobs[0].id}/cancel`, 'POST')).status).toBe(409);
    f.sqlite.prepare("UPDATE forwarding_jobs SET user_id=NULL").run(); await processForwarding(prepared.jobs[0], f.env);
    expect(f.send).not.toHaveBeenCalled(); expect(f.sqlite.prepare('SELECT status FROM forwarding_jobs').get()?.status).toBe('cancelled');
  });
});
