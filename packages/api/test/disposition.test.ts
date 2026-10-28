/**
 * Attachment classification.
 *
 * A misclassification here is silent data loss from the user's point of view:
 * a part marked inline is rendered in the body and never listed, so a real
 * attachment classified inline shows no paperclip, no chip and no download
 * link — the file appears never to have been sent, while its bytes sit in R2.
 *
 * Two bugs lived here. First `contentId != null` implied inline, which hid
 * every attachment from the many clients that stamp a Content-ID on ordinary
 * files. Then `related` implied inline, which still hid an explicitly
 * `Content-Disposition: attachment` PDF that happened to sit inside a
 * multipart/related container.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { testDatabase } from './helpers/database';
import { classifyDisposition, processInboundEmail } from '../src/services/email-processor';

describe('classifyDisposition', () => {
  it('honours an explicit attachment disposition above everything else', () => {
    // The exact regression: related container, has a Content-ID, but the
    // sender said "attachment".
    expect(classifyDisposition('attachment', true, 'someid', 'application/pdf')).toBe('attachment');
    expect(classifyDisposition('attachment', true, 'someid', 'image/png')).toBe('attachment');
  });

  it('honours an explicit inline disposition', () => {
    expect(classifyDisposition('inline', false, 'logo', 'image/png')).toBe('inline');
    expect(classifyDisposition('inline', false, '', 'image/gif')).toBe('inline');
  });

  it('infers inline only for a related, cid-referenced image', () => {
    expect(classifyDisposition(undefined, true, 'logo', 'image/png')).toBe('inline');
    expect(classifyDisposition(undefined, true, 'logo', 'image/jpeg')).toBe('inline');
  });

  it.each([
    ['no Content-ID', undefined, true, '', 'image/png'],
    ['not in a related container', undefined, false, 'logo', 'image/png'],
    ['cid-referenced PDF', undefined, true, 'doc', 'application/pdf'],
    ['cid-referenced zip', undefined, true, 'z', 'application/zip'],
    ['plain attachment', undefined, false, '', 'application/octet-stream'],
  ] as const)('treats %s as an attachment', (_label, raw, related, cid, mime) => {
    expect(classifyDisposition(raw, related, cid, mime)).toBe('attachment');
  });

  // Every part that is not provably inline must remain downloadable.
  it('defaults to attachment for unknown dispositions', () => {
    expect(classifyDisposition('something-else', false, '', 'text/plain')).toBe('attachment');
    expect(classifyDisposition(undefined, false, '', 'text/plain')).toBe('attachment');
  });
});

// The stored disposition is decided after embedding: the UI hides inline parts
// and has_attachments ignores them, so only a part that actually became a data:
// URI in the body may stay inline.
describe('stored disposition at ingest', () => {
  const open: ReturnType<typeof testDatabase>[] = [];
  afterEach(() => { for (const d of open.splice(0)) d.sqlite.close(); });
  async function ingest(parts: string[]) {
    const database = testDatabase(); open.push(database);
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, value: string | ArrayBuffer) => { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); },
      get: async (key: string) => { const o = objects.get(key); return o ? { size: o.byteLength, arrayBuffer: async () => o.slice().buffer, text: async () => new TextDecoder().decode(o) } : null; },
      delete: async (key: string) => { objects.delete(key); },
    };
    database.sqlite.prepare('INSERT INTO forwarding_configs(user_id,revision,config,updated_at) VALUES(?,1,?,?)')
      .run('u', JSON.stringify({ revision: 1, destinations: ['accounts@other.test'], forwardAll: 'accounts@other.test', rules: [] }), new Date().toISOString());
    const env = { MAILBOX_USER_ID: 'u', DB: database.db, EMAIL_BUCKET: bucket, EMAIL_DOMAIN: 'example.com', OUTBOUND_QUEUE: { sendBatch: async () => undefined },
      WEBSOCKET_HUB: { idFromName: () => 'u', get: () => ({ fetch: async () => new Response('{}') }) } } as unknown as Env;
    const mime = `From: sender@vendor.test\r\nTo: employee@example.com\r\nSubject: Parts\r\nContent-Type: multipart/related; boundary="B"\r\n\r\n${parts.map(p => `--B\r\n${p}\r\n`).join('')}--B--\r\n`;
    await bucket.put('raw', mime);
    await processInboundEmail({ rawKey: 'raw', from: 'sender@vendor.test', to: 'employee@example.com', rawSize: mime.length, receivedAt: new Date().toISOString() }, env);
    const email = database.sqlite.prepare('SELECT id,has_attachments,r2_body_key FROM emails').get()!;
    const rows = database.sqlite.prepare('SELECT filename,disposition FROM attachments ORDER BY filename').all();
    const snapshot = JSON.parse(new TextDecoder().decode(objects.get(`forwarding/${email.id}/message.json`)));
    return { email, rows: Object.fromEntries(rows.map(r => [r.filename, r.disposition])), html: new TextDecoder().decode(objects.get(String(email.r2_body_key))), snapshot };
  }
  const image = (cid: string, type = 'image/png', body = 'iVBORw0K', extra = '') =>
    `Content-Type: ${type}; name="${cid}"\r\nContent-ID: <${cid}>\r\nContent-Transfer-Encoding: base64${extra}\r\n\r\n${body}`;

  it('lists every inline part that was not embedded as an attachment, and counts it', async () => {
    const { email, rows, html, snapshot } = await ingest([
      'Content-Type: text/html\r\n\r\n<p>Hi</p><img src="cid:logo"><img src="cid:vector"><img src="cid:big">',
      image('logo'),
      image('vector', 'image/svg+xml', 'PHN2Zz48L3N2Zz4=', '\r\nContent-Disposition: inline'),
      image('big', 'image/png', 'A'.repeat(800_000)),
      image('unused'),
      'Content-Type: application/pdf\r\nContent-Disposition: inline; filename="doc.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=',
    ]);
    expect(rows).toEqual({ logo: 'inline', vector: 'attachment', big: 'attachment', unused: 'attachment', 'doc.pdf': 'attachment' });
    expect(email.has_attachments).toBe(1);
    expect(html).toContain('src="data:image/png;base64,iVBORw0K"');
    // Forwarding keeps the MIME classification, so the still-referenced part
    // keeps its Content-ID in the forwarded copy.
    expect(snapshot.attachments.find((a: { filename: string }) => a.filename === 'big')).toMatchObject({ disposition: 'inline', contentId: 'big' });
  });

  it('keeps an embedded image inline and does not count it', async () => {
    const { email, rows } = await ingest(['Content-Type: text/html\r\n\r\n<img src="cid:logo">', image('logo')]);
    expect(rows).toEqual({ logo: 'inline' });
    expect(email.has_attachments).toBe(0);
  });

  it('lists inline parts of a plain-text message, which has nothing to embed into', async () => {
    const { email, rows } = await ingest(['Content-Type: text/plain\r\n\r\nSee image', image('logo', 'image/png', 'iVBORw0K', '\r\nContent-Disposition: inline')]);
    expect(rows).toEqual({ logo: 'attachment' });
    expect(email.has_attachments).toBe(1);
  });
});
