import { processOutbound } from '../src/services/outbox';
import { cleanupProtocolObjects } from '../src/services/protocol-cleanup';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { testDatabase } from './helpers/database';
import { PROTOCOL_SCHEMA, PROTOCOL_CLEANUP_SCHEMA, PROTOCOL_CHANGES_SCHEMA } from '../src/durable-objects/protocol-schema';
import { protocolGateway, protocolSettings, protocolAdmin } from '../src/routes/protocol';
import { hashPassword, sessionTag } from '../src/lib/utils';
import type { Env, HonoVariables } from '../src/types';
import { exportProtocolMail, importProtocolMail, repairProtocolNotices } from '../src/services/protocol-mail';
import PostalMime from 'postal-mime';
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
    for (const f of fixtures.splice(0))
        f.sqlite.close();
});
async function setup() {
    const f = testDatabase();
    fixtures.push(f);
    f.sqlite.exec(PROTOCOL_SCHEMA);
    f.sqlite.exec(PROTOCOL_CLEANUP_SCHEMA);
    f.sqlite.exec(PROTOCOL_CHANGES_SCHEMA);
    f.sqlite.exec('CREATE TABLE IF NOT EXISTS mailbox_write_guard(valid INTEGER NOT NULL CHECK(valid=1))');
    const hash = await hashPassword('test-password-valid');
    f.sqlite.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, 'u');
    const appPassword = 'mp_' + 'ab'.repeat(32);
    f.sqlite.prepare('INSERT INTO protocol_passwords(id,user_id,name,token_hash,account_hash,created_at) VALUES(?,?,?,?,?,?)').run('p', 'u', 'test', await sessionTag(appPassword), await sessionTag(hash), new Date().toISOString());
    f.sqlite.prepare("INSERT INTO settings(key,value) VALUES('protocol_policy',?)").run(JSON.stringify({ imap: true, smtp: true, pop3: true, hostname: 'protocol.example.com' }));
    const data = new Map<string, Uint8Array>();
    const bucket = { put: vi.fn(async (k: string, v: any) => { data.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v)); }), get: vi.fn(async (k: string) => { const d = data.get(k); return d ? { text: async () => new TextDecoder().decode(d), arrayBuffer: async () => d.slice().buffer } : null; }), delete: vi.fn(async (k: string | string[]) => { for (const key of Array.isArray(k) ? k : [k])
            data.delete(key); }) };
    const env = { DB: f.db, MAILBOX_USER_ID: 'u', EMAIL_DOMAIN: 'example.com', APP_URL: 'https://example.com', EMAIL_BUCKET: bucket, OUTBOUND_QUEUE: { send: vi.fn() }, SEND_EMAIL: { send: vi.fn(async () => ({ messageId: 'provider-test' })) }, PROTOCOL_GATEWAY_SECRET: 'a'.repeat(48), WEBSOCKET_HUB: { idFromName: () => '', get: () => ({ fetch: async () => new Response() }) } } as unknown as Env;
    const app = new Hono<{
        Bindings: Env;
        Variables: HonoVariables;
    }>();
    app.route('/gateway', protocolGateway);
    app.use('/settings/*', async (c, next) => { c.set('userId', 'u'); await next(); });
    app.route('/settings', protocolSettings);
    const request = (path: string, method = 'GET', body?: unknown, protocol = 'imap', email = 'employee@example.com') => app.request('/gateway' + path, { method, headers: { Authorization: 'Basic ' + btoa(email + ':' + appPassword), 'X-Gateway-Key': env.PROTOCOL_GATEWAY_SECRET!, 'X-Mail-Protocol': protocol, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    return { ...f, env, data, bucket, appPassword, request, app };
}
const raw = new TextEncoder().encode('From: Employee <employee@example.com>\r\nTo: target@example.net\r\nSubject: Hello\r\nMessage-ID: <client-1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA test message\r\n');
describe('mail protocol security and storage', () => {
    it('sends SMTP imports with string display names required by the live binding', async () => {
        const f = await setup();
        const mime = new TextEncoder().encode('From: employee@example.com\r\nTo: target@example.net\r\nCc: Colleague <copy@example.net>\r\nSubject: Outlook regression\r\n\r\nTest');
        const id = await importProtocolMail(f.env, 'u', 'employee@example.com', mime, 'sent', [], new Date().toISOString(), ['target@example.net', 'copy@example.net', 'hidden@example.net']);
        vi.mocked(f.env.SEND_EMAIL.send).mockImplementationOnce(async (message: any) => {
            for (const address of [message.from, ...message.to, ...message.cc, ...message.bcc]) {
                if (typeof address.name !== 'string') throw new TypeError('Incorrect type for name');
            }
            expect(message.from).toEqual({ email: 'employee@example.com', name: '' });
            expect(message.cc).toEqual([{ email: 'copy@example.net', name: 'Colleague' }]);
            return { messageId: 'provider-outlook-test' };
        });
        await processOutbound({ kind: 'outbound', userId: 'u', emailId: id }, f.env);
        expect(f.env.SEND_EMAIL.send).toHaveBeenCalledTimes(1);
        expect(f.sqlite.prepare('SELECT status FROM outbound_jobs WHERE email_id=?').get(id)!.status).toBe('sent');
    });
    it('logs an unclassified sending failure without retrying or exposing message content', async () => {
        const f = await setup();
        const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net']);
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            vi.mocked(f.env.SEND_EMAIL.send).mockRejectedValueOnce(new Error('Binding failure for target@example.net'));
            const job = { kind: 'outbound' as const, userId: 'u', emailId: id };
            await processOutbound(job, f.env);
            await processOutbound(job, f.env);
            expect(f.env.SEND_EMAIL.send).toHaveBeenCalledTimes(1);
            expect(f.sqlite.prepare('SELECT status FROM outbound_jobs WHERE email_id=?').get(id)!.status).toBe('uncertain');
            expect(log).toHaveBeenCalledWith('Outbound sending call failed', {
                emailId: id, attempt: 1, code: 'UNCLASSIFIED', message: 'Binding failure for [email]',
            });
            expect(JSON.stringify(log.mock.calls)).not.toContain('A test message');
        } finally { log.mockRestore(); }
    });
    it('assigns stable non-reused UIDs across webmail insert, move and delete', async () => { const f = await setup(); f.email('one'); const a = Number(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid); f.sqlite.prepare("UPDATE emails SET is_read=1 WHERE id='one'").run(); expect(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid).toBe(a); f.sqlite.prepare("UPDATE emails SET folder_id='archive' WHERE id='one'").run(); const b = Number(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid); expect(b).toBeGreaterThan(a); f.sqlite.prepare("DELETE FROM emails WHERE id='one'").run(); f.email('two'); expect(Number(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid)).toBeGreaterThan(b); });
    it('requires both gateway credentials and an active per-user app password', async () => { const f = await setup(); expect((await f.request('/auth')).status).toBe(200); expect((await f.request('/auth', 'GET', undefined, 'imap', 'someone@example.com')).status).toBe(401); expect((await f.app.request('/gateway/auth', {}, f.env)).status).toBe(401); f.sqlite.prepare("UPDATE protocol_passwords SET revoked_at='now'").run(); expect((await f.request('/auth')).status).toBe(401); });
    it('honors admin disable and account password changes on the next operation', async () => { const f = await setup(); f.sqlite.prepare("INSERT INTO protocol_user_access VALUES('u',0)").run(); expect((await f.request('/auth')).status).toBe(401); f.sqlite.prepare('DELETE FROM protocol_user_access').run(); f.sqlite.prepare("UPDATE settings SET value='{}' WHERE key='protocol_policy'").run(); expect((await f.request('/auth')).status).toBe(403); f.sqlite.prepare("UPDATE settings SET value='{\"imap\":true}' WHERE key='protocol_policy'").run(); f.sqlite.prepare("UPDATE users SET password_hash='changed'").run(); expect((await f.request('/auth')).status).toBe(401); });
    it('keeps SMTP from reading mail and POP3 from opening non-inbox folders', async () => { const f = await setup(); expect((await f.request('/folders', 'GET', undefined, 'smtp')).status).toBe(403); expect((await f.request('/messages?folder=sent', 'GET', undefined, 'pop3')).status).toBe(403); });
    it('submits to the durable outbox once and deduplicates Outlook Sent APPEND', async () => { const f = await setup(); const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', ['\\Seen'], new Date().toISOString(), ['target@example.net']); const again = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net']); const appended = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), undefined, 'append-1'); expect(again).toBe(id); expect(appended).toBe(id); expect(f.sqlite.prepare('SELECT COUNT(*) n FROM outbound_jobs').get()!.n).toBe(1); expect(await exportProtocolMail(f.env, 'u', id)).toEqual(raw); const parsed = await PostalMime.parse((await exportProtocolMail(f.env, 'u', id))!.buffer as ArrayBuffer); expect(parsed.subject).toBe('Hello'); });
    it('rejects spoofed sending and does not give access to another mailbox', async () => { const f = await setup(); await expect(importProtocolMail(f.env, 'u', 'other@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net'])).rejects.toThrow('From address'); f.email('private'); expect(await exportProtocolMail(f.env, 'other', 'private')).toBeNull(); expect((await f.request('/raw/private', 'GET', undefined, 'smtp')).status).toBe(403); });
    it('expunges only marked messages and preserves pending deliveries', async () => { const f = await setup(); f.email('keep'); const uid = f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid; await f.request('/expunge', 'POST', { ids: ['keep'], uids: { keep: uid } }); expect(f.sqlite.prepare("SELECT id FROM emails WHERE id='keep'").get()).toBeTruthy(); await f.request('/flags/keep?uid=' + uid, 'PATCH', { flags: ['\\Deleted'] }); await f.request('/expunge', 'POST', { ids: ['keep'], uids: { keep: uid } }); expect(f.sqlite.prepare("SELECT id FROM emails WHERE id='keep'").get()).toBeUndefined(); });
    it('allows only super admins to change policy', async () => {
        const f = await setup();
        const app = new Hono<{
            Bindings: Env;
            Variables: HonoVariables;
        }>();
        app.use('*', async (c, next) => { c.set('userRole', 'admin'); await next(); });
        app.route('/', protocolAdmin);
        expect((await app.request('/', {}, f.env)).status).toBe(403);
    });
    it('does not conflate different SMTP envelopes for identical MIME', async () => { const f = await setup(); const a = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net']); const b = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['other@example.net']); expect(a).not.toBe(b); });
    it('rejects stale UID flag operations after a webmail move', async () => { const f = await setup(); f.email('m'); const uid = f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid; f.sqlite.prepare("UPDATE emails SET folder_id='archive' WHERE id='m'").run(); expect((await f.request('/flags/m?uid=' + uid, 'PATCH', { flags: ['\\Seen'], operation: 'add' })).status).toBe(404); expect(f.sqlite.prepare("SELECT is_read FROM emails WHERE id='m'").get()!.is_read).toBe(0); });
    it('adds and removes flags without erasing unrelated state', async () => { const f = await setup(); f.email('m'); const uid = f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid; const path = '/flags/m?uid=' + uid; await f.request(path, 'PATCH', { flags: ['\\Flagged'], operation: 'add' }); await f.request(path, 'PATCH', { flags: ['\\Seen'], operation: 'add' }); const result = await (await f.request(path, 'PATCH', { flags: ['\\Seen'], operation: 'remove' })).json() as any; expect(result.flags).toEqual(['\\Flagged']); });
    it('assigns a new UID for a replaced draft body', async () => { const f = await setup(); f.email('m', 'drafts'); const uid = Number(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid); f.sqlite.prepare("UPDATE emails SET r2_body_key='new-body' WHERE id='m'").run(); expect(Number(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid)).toBeGreaterThan(uid); });
    it('creates one local failure notice and does not recreate a deleted notice', async () => { const f = await setup(); const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net']); f.sqlite.prepare("UPDATE outbound_jobs SET status='failed' WHERE email_id=?").run(id); await repairProtocolNotices(f.env, 'u'); await repairProtocolNotices(f.env, 'u'); expect(f.sqlite.prepare("SELECT COUNT(*) n FROM emails WHERE folder_id='in'").get()!.n).toBe(1); f.sqlite.prepare("DELETE FROM emails WHERE folder_id='in'").run(); await repairProtocolNotices(f.env, 'u'); expect(f.sqlite.prepare("SELECT COUNT(*) n FROM emails WHERE folder_id='in'").get()!.n).toBe(0); });
    it('does not expunge a pending delivery', async () => { const f = await setup(); const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net']); const uid = f.sqlite.prepare('SELECT uid FROM protocol_messages WHERE email_id=?').get(id)!.uid; await f.request('/flags/' + id + '?uid=' + uid, 'PATCH', { flags: ['\\Deleted'] }); expect((await f.request('/expunge', 'POST', { ids: [id], uids: { [id]: uid } })).status).toBe(400); expect(f.sqlite.prepare('SELECT id FROM emails WHERE id=?').get(id)).toBeTruthy(); });
    it('stores hashes of device passwords', async () => { const f = await setup(); const response = await f.app.request('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Laptop', password: 'test-password-valid' }) }, f.env); expect(response.status).toBe(201); const v = await response.json() as any; const row = f.sqlite.prepare('SELECT token_hash FROM protocol_passwords WHERE id=?').get(v.data.id)!; expect(row.token_hash).not.toBe(v.data.password); expect(row.token_hash).toBe(await sessionTag(v.data.password)); });
});
describe('protocol review regressions', () => {
    it('rejects stale MIME reads before storage access and after a concurrent edit', async () => {
        const f = await setup();
        const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'drafts', [], new Date().toISOString(), undefined, 'draft-stale');
        const uid = Number(f.sqlite.prepare('SELECT uid FROM protocol_messages WHERE email_id=?').get(id)!.uid);
        f.sqlite.prepare("UPDATE emails SET message_id='replacement' WHERE id=?").run(id);
        f.bucket.get.mockClear();
        expect((await f.request(`/raw/${id}?uid=${uid}`)).status).toBe(409);
        expect(f.bucket.get).not.toHaveBeenCalled();
        const fresh = Number(f.sqlite.prepare('SELECT uid FROM protocol_messages WHERE email_id=?').get(id)!.uid);
        const originalGet = f.bucket.get.getMockImplementation()!;
        let changed = false;
        f.bucket.get.mockImplementation(async (k: string) => {
            const value = await originalGet(k);
            if (!changed) {
                changed = true;
                f.sqlite.prepare("UPDATE emails SET message_id='changed-during-read' WHERE id=?").run(id);
            }
            return value;
        });
        expect((await f.request(`/raw/${id}?uid=${fresh}`)).status).toBe(409);
    });
    it('requeues known failures once while refusing uncertain deliveries', async () => {
        const f = await setup();
        const send = () => importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'sent', [], new Date().toISOString(), ['target@example.net']);
        const id = await send();
        f.sqlite.prepare("UPDATE outbound_jobs SET status='failed',attempts=72").run();
        f.sqlite.prepare("UPDATE emails SET delivery_status='failed'").run();
        expect(await send()).toBe(id);
        expect(f.sqlite.prepare('SELECT status,attempts FROM outbound_jobs').get()).toMatchObject({ status: 'queued', attempts: 0 });
        expect(await send()).toBe(id);
        expect(f.sqlite.prepare('SELECT COUNT(*) n FROM outbound_jobs').get()!.n).toBe(1);
        f.sqlite.prepare("UPDATE outbound_jobs SET status='uncertain'").run();
        await expect(send()).rejects.toThrow('uncertain');
        expect(f.sqlite.prepare('SELECT status FROM outbound_jobs').get()!.status).toBe('uncertain');
    });
    it('preserves Reply-To and rejects unsupported multiple reply destinations', async () => {
        const f = await setup();
        const withReply = (value: string) => new TextEncoder().encode('Reply-To: ' + value + '\r\n' + new TextDecoder().decode(raw));
        await importProtocolMail(f.env, 'u', 'employee@example.com', withReply('Support <support@example.net>'), 'sent', [], new Date().toISOString(), ['target@example.net']);
        const payload = JSON.parse(String(f.sqlite.prepare('SELECT payload FROM outbound_jobs').get()!.payload));
        expect(payload.replyTo).toBe('support@example.net');
        const job = f.sqlite.prepare('SELECT email_id FROM outbound_jobs').get()!;
        await processOutbound({ kind: 'outbound', userId: 'u', emailId: String(job.email_id) }, f.env);
        expect(f.env.SEND_EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'support@example.net' }));
        await expect(importProtocolMail(f.env, 'u', 'employee@example.com', withReply('a@example.net,b@example.net'), 'sent', [], new Date().toISOString(), ['target@example.net'])).rejects.toThrow('Reply-To');
    });
    it('retains a cleanup intent after partial R2 failure and retries deletion', async () => {
        const f = await setup();
        f.bucket.put.mockImplementationOnce(async (k: string, v: any) => { f.data.set(k, new TextEncoder().encode(String(v))); });
        f.bucket.put.mockRejectedValueOnce(new Error('R2 put failed'));
        f.bucket.delete.mockRejectedValueOnce(new Error('R2 delete failed'));
        await expect(importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'drafts', [], new Date().toISOString(), undefined, 'fail-write')).rejects.toThrow('R2 put failed');
        expect(f.data.size).toBe(1);
        expect(f.sqlite.prepare('SELECT COUNT(*) n FROM protocol_object_gc').get()!.n).toBe(1);
        f.sqlite.prepare("UPDATE protocol_object_gc SET not_before='2000-01-01'").run();
        await cleanupProtocolObjects(f.env);
        expect(f.data.size).toBe(0);
        expect(f.sqlite.prepare('SELECT COUNT(*) n FROM protocol_object_gc').get()!.n).toBe(0);
    });
    it('commits deletion with a retryable cleanup job when R2 is unavailable', async () => {
        const f = await setup();
        const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'in', ['\\Deleted'], new Date().toISOString(), undefined, 'gc-delete');
        const uid = Number(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid);
        f.bucket.delete.mockRejectedValueOnce(new Error('R2 down'));
        expect((await f.request('/expunge', 'POST', { ids: [id], uids: { [id]: uid } })).status).toBe(200);
        expect(f.sqlite.prepare('SELECT id FROM emails WHERE id=?').get(id)).toBeUndefined();
        expect(f.data.size).toBeGreaterThan(0);
        expect(f.sqlite.prepare('SELECT COUNT(*) n FROM protocol_object_gc').get()!.n).toBe(1);
        f.sqlite.prepare("UPDATE protocol_object_gc SET not_before='2000-01-01'").run();
        await cleanupProtocolObjects(f.env);
        expect(f.data.size).toBe(0);
    });
    it('does not collect active imports or committed messages, but recovers abandoned intents', async () => {
        const f = await setup();
        f.email('live');
        for (const [id, date] of [['live', '2000-01-01'], ['active', '2999-01-01'], ['abandoned', '2000-01-01']]) {
            f.data.set(id, new Uint8Array([1]));
            f.sqlite.prepare('INSERT INTO protocol_object_gc(id,email_id,keys_json,not_before) VALUES(?,?,?,?)').run(id, id, JSON.stringify([id]), date);
        }
        await cleanupProtocolObjects(f.env);
        expect([...f.data.keys()].sort()).toEqual(['active', 'live']);
    });
});
it('preserves committed objects after an ambiguous database response', async () => {
    const f = await setup();
    const batch = f.env.DB.batch.bind(f.env.DB);
    vi.spyOn(f.env.DB, 'batch').mockImplementationOnce(async (statements) => { await batch(statements); throw Error('response lost'); });
    const id = await importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'drafts', [], new Date().toISOString(), undefined, 'commit-response-lost');
    expect(f.sqlite.prepare('SELECT id FROM emails').get()!.id).toBe(id);
    expect(f.data.size).toBe(3);
    expect(f.sqlite.prepare('SELECT count(*) n FROM protocol_object_gc').get()!.n).toBe(0);
});
it('fences an import whose cleanup job was claimed before commit', async () => {
    const f = await setup();
    const original = f.bucket.put.getMockImplementation()!;
    f.bucket.put.mockImplementation(async (k: string, v: any) => {
        await original(k, v);
        f.sqlite.prepare("UPDATE protocol_object_gc SET state='deleting'").run();
    });
    await expect(importProtocolMail(f.env, 'u', 'employee@example.com', raw, 'drafts', [], new Date().toISOString(), undefined, 'expired-import')).rejects.toThrow();
    expect(f.sqlite.prepare('SELECT count(*) n FROM emails').get()!.n).toBe(0);
    expect(f.data.size).toBe(0);
});


describe('incremental protocol synchronization', () => {
    it('returns flags, new UIDs, moves and deletion tombstones without a full listing', async () => {
        const f=await setup(); f.email('one'); f.email('two');
        const before=(await (await f.request('/revision')).json() as any).revision;
        const uid=f.sqlite.prepare("SELECT uid FROM protocol_messages WHERE email_id='one'").get()!.uid;
        f.sqlite.prepare("UPDATE emails SET is_read=1,is_starred=1 WHERE id='one'").run();
        f.sqlite.prepare("UPDATE emails SET folder_id='archive' WHERE id='two'").run();
        const result=await (await f.request(`/changes?folder=in&after=${before}`)).json() as any;
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]).toMatchObject({id:'one',uid,flags:['\\Seen','\\Flagged']});
        expect(result.removed).toEqual(['two']);
        const moved=await (await f.request(`/changes?folder=archive&after=${before}`)).json() as any;
        expect(moved.messages.map((x:any)=>x.id)).toEqual(['two']);
        f.sqlite.prepare("UPDATE emails SET r2_body_key='replacement' WHERE id='one'").run();
        const changed=await (await f.request(`/changes?folder=in&after=${result.revision}`)).json() as any;
        expect(changed.messages[0].uid).toBeGreaterThan(Number(uid));
        f.sqlite.prepare("DELETE FROM emails WHERE id='one'").run();
        const deleted=await (await f.request(`/changes?folder=in&after=${changed.revision}`)).json() as any;
        expect(deleted.removed).toEqual(['one']); expect(deleted.messages).toEqual([]);
    });
    it('bounds journal history and requires a full resync for stale or future cursors', async () => {
        const f=await setup(); f.email('one');
        const uid=f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid;
        f.sqlite.exec(PROTOCOL_CHANGES_SCHEMA);
        expect(f.sqlite.prepare('SELECT uid FROM protocol_messages').get()!.uid).toBe(uid);
        f.sqlite.exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10020) INSERT INTO protocol_changes(email_id,folder_id) SELECT NULL,'in' FROM n");
        expect(Number(f.sqlite.prepare('SELECT COUNT(*) n FROM protocol_changes').get()!.n)).toBeLessThanOrEqual(10001);
        expect((await f.request('/changes?folder=in&after=1')).status).toBe(409);
        expect((await f.request('/changes?folder=in&after=99999999')).status).toBe(409);
        expect((await f.request('/changes?folder=missing&after=0')).status).toBe(404);
        expect((await f.request('/changes?folder=in&after=0','GET',undefined,'smtp')).status).toBe(403);
    });
});


it('supports a switched user while requiring their password and enforcing session ownership', async () => {
    const f = await setup();
    const create = (password: string) => f.app.request('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'original_session=admin-backup' },
        body: JSON.stringify({ name: 'Outlook', password, userId: 'other', user_id: 'other' }),
    }, f.env);
    const before = Number(f.sqlite.prepare('SELECT COUNT(*) n FROM protocol_passwords').get()!.n);
    const rejected = await create('wrong-password');
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: 'Current password is incorrect' });
    expect(Number(f.sqlite.prepare('SELECT COUNT(*) n FROM protocol_passwords').get()!.n)).toBe(before);
    const accepted = await create('test-password-valid');
    expect(accepted.status).toBe(201);
    const result = await accepted.json() as any;
    const row = f.sqlite.prepare('SELECT user_id,token_hash FROM protocol_passwords WHERE id=?').get(result.data.id)!;
    expect(row.user_id).toBe('u');
    expect(row.token_hash).toBe(await sessionTag(result.data.password));
});


it('allows passwordless creation only for a live bound super-admin switch', async () => {
    const f = await setup();
    f.sqlite.exec("INSERT INTO users(id,email,display_name,password_hash,role,must_reset_password) VALUES('sa','sa@example.com','SA','h','super_admin',0)");
    const adminTag = await sessionTag('admin-token'), targetTag = await sessionTag('target-token');
    const expires = new Date(Date.now()+3600000).toISOString();
    const insert = f.sqlite.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)');
    insert.run(adminTag,'sa',expires,new Date().toISOString());
    insert.run(targetTag,'u',expires,new Date().toISOString());
    const create = (cookie = `session_token=target-token; original_session=admin-token.${targetTag}`) => f.app.request('/settings', {
        method:'POST', headers:{'Content-Type':'application/json', Cookie:cookie},
        body:JSON.stringify({name:'Admin provisioned',userId:'sa'}),
    },f.env);
    expect((await create('')).status).toBe(403);
    expect((await create('session_token=target-token; original_session=admin-token.invalid')).status).toBe(403);
    expect((await create(`session_token=target-token; original_session=forged.${targetTag}`)).status).toBe(403);
    f.sqlite.prepare("UPDATE users SET role='admin' WHERE id='sa'").run();
    expect((await create()).status).toBe(403);
    f.sqlite.prepare("UPDATE users SET role='super_admin',must_reset_password=1 WHERE id='sa'").run();
    expect((await create()).status).toBe(403);
    f.sqlite.prepare("UPDATE users SET must_reset_password=0 WHERE id='sa'").run();
    for (const tag of [adminTag,targetTag]) {
        f.sqlite.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00Z' WHERE token=?").run(tag);
        expect((await create()).status).toBe(403);
        f.sqlite.prepare('UPDATE sessions SET expires_at=? WHERE token=?').run(expires,tag);
    }
    f.sqlite.prepare('UPDATE sessions SET user_id=? WHERE token=?').run('sa',targetTag);
    expect((await create()).status).toBe(403);
    f.sqlite.prepare('UPDATE sessions SET user_id=? WHERE token=?').run('u',targetTag);
    const response=await create();expect(response.status).toBe(201);
    const result=await response.json() as any;
    expect(f.sqlite.prepare('SELECT user_id FROM protocol_passwords WHERE id=?').get(result.data.id)!.user_id).toBe('u');
    f.sqlite.prepare('DELETE FROM sessions WHERE token=?').run(adminTag);
    expect((await create()).status).toBe(403);
});
