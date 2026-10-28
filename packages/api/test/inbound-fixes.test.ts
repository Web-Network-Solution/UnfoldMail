import { afterEach, describe, expect, it } from 'vitest';
import type { Env, InboundEmailMessage } from '../src/types';
import { testDatabase } from './helpers/database';
import { embedInlineImages, processInboundEmail } from '../src/services/email-processor';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => { for (const d of open.splice(0)) d.sqlite.close(); });
function inbound() {
  const database = testDatabase(); open.push(database);
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: string | ArrayBuffer) => { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); },
    get: async (key: string) => { const o = objects.get(key); return o ? { size: o.byteLength, arrayBuffer: async () => o.slice().buffer, text: async () => new TextDecoder().decode(o) } : null; },
    delete: async (key: string) => { objects.delete(key); },
  };
  const env = { MAILBOX_USER_ID: 'u', DB: database.db, EMAIL_BUCKET: bucket, EMAIL_DOMAIN: 'example.com', OUTBOUND_QUEUE: { sendBatch: async () => undefined },
    WEBSOCKET_HUB: { idFromName: () => 'u', get: () => ({ fetch: async () => new Response('{}') }) } } as unknown as Env;
  async function deliver(mime: string, patch: Partial<InboundEmailMessage> = {}) {
    const message = { rawKey: 'raw', from: 'sender@vendor.test', to: 'employee@example.com', rawSize: mime.length, receivedAt: new Date().toISOString(), ...patch };
    await bucket.put(message.rawKey, mime);
    await processInboundEmail(message, env);
  }
  const text = (key: string) => new TextDecoder().decode(objects.get(key));
  const count = () => database.sqlite.prepare('SELECT COUNT(*) n FROM emails').get()!.n;
  return { ...database, objects, env, deliver, text, count };
}
const plain = 'From: sender@vendor.test\r\nTo: employee@example.com\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nNo Message-ID here';

describe('cid: embedding matches the exact token', () => {
  it('does not rewrite cid:img10 as cid:img1 and escapes regex metacharacters', async () => {
    const f = inbound();
    const part = (cid: string, body: string) => `--B\r\nContent-Type: image/png\r\nContent-ID: <${cid}>\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n`;
    await f.deliver('From: sender@vendor.test\r\nTo: employee@example.com\r\nSubject: Images\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n' +
      '--B\r\nContent-Type: text/html\r\n\r\n<img src="cid:img1"><img src="cid:img10"><img src="cid:a.b+c@x"><img src="cid:aXbbc@x">\r\n' +
      part('img1', 'AQID') + part('img10', 'BAUG') + part('a.b+c@x', 'BwgJ') + '--B--\r\n');
    const html = f.text(String(f.sqlite.prepare('SELECT r2_body_key FROM emails').get()!.r2_body_key));
    expect(html).toContain('src="data:image/png;base64,AQID"');
    expect(html).toContain('src="data:image/png;base64,BAUG"');
    expect(html).toContain('src="data:image/png;base64,BwgJ"');
    // A regex-shaped look-alike of a.b+c@x is not a reference to it.
    expect(html).toContain('src="cid:aXbbc@x"');
  });
});

describe('failed commit cleanup', () => {
  const race = '<race@vendor.test>';
  it('rolls back its own R2 objects when a concurrent delivery won the claim', async () => {
    const f = inbound(); const batch = f.db.batch.bind(f.db);
    Object.assign(f.db, { batch: async (statements: D1PreparedStatement[]) => {
      f.sqlite.prepare('INSERT INTO processed_inbound(message_key,user_id,email_id,processed_at) VALUES(?,?,?,?)').run(`sender@vendor.test|${race}`, 'u', 'winner', new Date().toISOString());
      return batch(statements);
    } });
    await expect(f.deliver(plain, { messageKey: race })).rejects.toThrow();
    expect([...f.objects.keys()]).toEqual(['raw']);
  });
  it('keeps its R2 objects when its own commit landed but the response was lost', async () => {
    const f = inbound(); const batch = f.db.batch.bind(f.db);
    Object.assign(f.db, { batch: async (statements: D1PreparedStatement[]) => { await batch(statements); throw new Error('response lost'); } });
    await expect(f.deliver(plain, { messageKey: race })).rejects.toThrow('response lost');
    expect(f.objects.has(String(f.sqlite.prepare('SELECT r2_body_key FROM emails').get()!.r2_body_key))).toBe(true);
  });
});

describe('dedupe without a Message-ID', () => {
  it('drops a byte-identical redelivery from the same sender only', async () => {
    const f = inbound();
    await f.deliver(plain, { rawKey: 'raw-1' });
    await f.deliver(plain, { rawKey: 'raw-2' });
    expect(f.count()).toBe(1);
    expect(f.objects.has('raw-2')).toBe(false);
    await f.deliver(plain, { rawKey: 'raw-3', from: 'other@vendor.test' });
    await f.deliver(plain.replace('here', 'there'), { rawKey: 'raw-4' });
    expect(f.count()).toBe(3);
  });
});

describe('filter text of HTML-only mail', () => {
  it('ignores style, script and head contents, in filters and the snippet', async () => {
    const f = inbound();
    const rule = (id: string, contains: string, actions: object) => ({ id, name: id, enabled: true, match: 'all', conditions: { contains }, actions, stop: false });
    f.sqlite.prepare('INSERT INTO forwarding_configs(user_id,revision,config,updated_at) VALUES(?,1,?,?)').run('u', JSON.stringify({ revision: 1, destinations: [], forwardAll: null,
      rules: [rule('style', 'color', { star: true }), rule('title', 'secret', { star: true }), rule('script', 'tracker', { star: true }), rule('visible', 'hello', { markRead: true })] }), new Date().toISOString());
    await f.deliver('From: sender@vendor.test\r\nTo: employee@example.com\r\nSubject: Promo\r\nContent-Type: text/html\r\n\r\n' +
      '<html><head><title>secret</title><style>.x{color:red}</style></head><body><p>Hello</p><script>tracker()</script></body></html>');
    expect(f.sqlite.prepare('SELECT is_starred,is_read,snippet FROM emails').get()).toEqual({ is_starred: 0, is_read: 1, snippet: 'Hello' });
  });

  it('ingests a 1 MiB body of unclosed openers without pinning the CPU', async () => {
    const f = inbound();
    f.sqlite.prepare('INSERT INTO forwarding_configs(user_id,revision,config,updated_at) VALUES(?,1,?,?)').run('u', JSON.stringify({ revision: 1, destinations: [], forwardAll: null,
      rules: [{ id: 'r', name: 'r', enabled: true, match: 'all', conditions: { contains: 'hello' }, actions: { star: true }, stop: false }] }), new Date().toISOString());
    const body = '<p>Hello</p>' + '<style><head><script<!--'.repeat(Math.ceil((1 << 20) / 24)) + '</p>';
    const started = performance.now();
    await f.deliver('From: sender@vendor.test\r\nTo: employee@example.com\r\nSubject: Poison\r\nContent-Type: text/html\r\n\r\n' + body);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(f.sqlite.prepare('SELECT is_starred,snippet FROM emails').get()).toEqual({ is_starred: 1, snippet: 'Hello' });
  });
});

describe('inline image embedding cost', () => {
  const png = (n = 3) => ({ filename: 'i.png', mimeType: 'image/png', content: new Uint8Array(n).buffer, disposition: 'inline' as const });
  it('embeds exact tokens case-insensitively and leaves unknown or prefix tokens alone', () => {
    const embedded = new Set<Parameters<typeof embedInlineImages>[1][number]>();
    const a = { ...png(), contentId: 'Img1' }, b = { ...png(), contentId: 'img1' };
    const out = embedInlineImages('<img src="cid:img1"><img src=\'CID:IMG1\'><img src="cid:img10"><i>cid:img1</i>', [a, b], embedded);
    expect(out).toBe('<img src="data:image/png;base64,AAAA"><img src=\'data:image/png;base64,AAAA\'><img src="cid:img10"><i>cid:img1</i>'); // `<` ends no token, same as cidPattern
    expect([...embedded]).toEqual([a]); // the duplicate Content-ID is not embedded twice
  });
  it('stays linear with thousands of inline parts over a large body', () => {
    const parts = Array.from({ length: 40_000 }, (_, i) => ({ ...png(), contentId: `p${i}` }));
    const body = '<p>' + 'x'.repeat(1 << 20) + '</p><img src="cid:p39999">';
    const embedded = new Set<Parameters<typeof embedInlineImages>[1][number]>();
    const started = performance.now();
    const out = embedInlineImages(body, parts, embedded);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out.endsWith('<img src="data:image/png;base64,AAAA">')).toBe(true);
    expect(embedded.size).toBe(1);
  });
});
