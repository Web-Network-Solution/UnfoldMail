import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabase } from './helpers/database';
import { getEvent, saveEvent } from '../src/services/calendar';
import { processInboundEmail } from '../src/services/email-processor';
import { parseCalendarReply, type CalendarInput } from '@email-service/shared/productivity';
import type { Env } from '../src/types';

const open: ReturnType<typeof testDatabase>[] = [];
afterEach(() => { for (const d of open.splice(0)) d.sqlite.close(); vi.restoreAllMocks(); });

const input: CalendarInput = { title: 'Planning', description: '', location: '', start: '2030-03-09T14:00:00.000Z', end: '2030-03-09T15:00:00.000Z', timezone: 'UTC', allDay: false, recurrence: '', attendees: ['guest@external.test'], reminderMinutes: null };
const ics = (uid: string, { attendee = 'guest@external.test', partstat = 'ACCEPTED', method = 'REPLY', extra = [] as string[] } = {}) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20300101T000000Z', ...extra,
    `ATTENDEE;PARTSTAT=${partstat}:mailto:${attendee}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

function fixture() {
  const database = testDatabase(); open.push(database);
  database.sqlite.exec("INSERT INTO users(id,email,display_name,password_hash,role) VALUES('other','other@example.com','Other','h','employee')");
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: string | ArrayBuffer) => { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); },
    get: async (key: string) => { const o = objects.get(key); return o ? { size: o.byteLength, arrayBuffer: async () => o.slice().buffer } : null; },
    delete: async (key: string) => { objects.delete(key); },
  };
  const env = { MAILBOX_USER_ID: 'u', DB: database.db, EMAIL_BUCKET: bucket, EMAIL_DOMAIN: 'example.com', APP_URL: 'https://mail.example.com',
    OUTBOUND_QUEUE: { sendBatch: async () => undefined }, WEBSOCKET_HUB: { idFromName: () => 'u', get: () => ({ fetch: async () => new Response('{}') }) } } as unknown as Env;
  let n = 0;
  /** Delivers to employee@example.com (the owner of events made by `make`). */
  async function deliver(calendar: string, { from = 'guest@external.test', inline = false, headers = '', automated = false } = {}) {
    const mime = `From: ${from}\r\nTo: employee@example.com\r\nSubject: Accepted: Planning\r\n${headers}Content-Type: multipart/mixed; boundary="B"\r\n\r\n` +
      `--B\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n--B\r\nContent-Type: text/calendar; method=REPLY; charset=utf-8\r\n` +
      (inline ? '' : 'Content-Disposition: attachment; filename="reply.ics"\r\n') + `\r\n${calendar}\r\n--B--\r\n`;
    const message = { rawKey: `raw-${++n}`, messageKey: `<m${n}@test>`, from, to: 'employee@example.com', rawSize: mime.length, receivedAt: new Date().toISOString(), automated };
    await bucket.put(message.rawKey, mime);
    await processInboundEmail(message, env);
  }
  const make = (owner = 'u', email = 'employee@example.com') => saveEvent(env, owner, email, input, null);
  const response = async (id: string, email = 'guest@external.test') => (await getEvent(env, id))?.responses.find((r) => r.email === email)?.response;
  const delivered = () => database.sqlite.prepare('SELECT COUNT(*) n FROM emails').get()!.n;
  const notifications = () => database.sqlite.prepare("SELECT COUNT(*) n FROM calendar_deliveries WHERE kind='response'").get()!.n;
  return { ...database, env, deliver, make, response, delivered, notifications };
}

describe('parseCalendarReply', () => {
  it('reads the UID, attendee, PARTSTAT and RECURRENCE-ID of an iTIP REPLY and rejects other methods', () => {
    expect(parseCalendarReply(ics('a@example.com', { attendee: 'Guest@External.Test', partstat: 'TENTATIVE' }))).toEqual({ uid: 'a@example.com', attendee: 'guest@external.test', partstat: 'tentative' });
    expect(parseCalendarReply(ics('a@example.com', { extra: ['RECURRENCE-ID:20300310T140000Z'] })).recurrenceId).toBeTruthy();
    expect(() => parseCalendarReply(ics('a@example.com', { method: 'REQUEST' }))).toThrow();
    expect(() => parseCalendarReply('not a calendar')).toThrow();
  });
});

describe('Emailed RSVP replies (C2)', () => {
  it('applies an accepted reply from the attendee to the owner\'s event without queuing a notification', async () => {
    const f = fixture(), event = await f.make();
    await f.deliver(ics(event.uid));
    expect(await f.response(event.id)).toBe('accepted');
    expect(f.notifications()).toBe(0);
    expect(f.delivered()).toBe(1);
    await f.deliver(ics(event.uid, { partstat: 'DECLINED' }), { inline: true });
    expect(await f.response(event.id)).toBe('declined');
    expect(f.delivered()).toBe(2);
  });

  it('ignores a spoofed sender, another owner\'s event, unknown UIDs, cancelled events, occurrence replies and non-answers', async () => {
    const f = fixture(), event = await f.make();
    const others = await f.make('other', 'other@example.com');
    const cancelled = await f.make();
    await saveEvent(f.env, 'u', 'employee@example.com', cancelled, cancelled, 1, 'cancelled');
    await f.deliver(ics(event.uid), { from: 'attacker@evil.test' });
    await f.deliver(ics(event.uid, { attendee: 'attacker@evil.test' }), { from: 'attacker@evil.test' });
    await f.deliver(ics(others.uid));
    await f.deliver(ics('unknown@example.com'));
    await f.deliver(ics(`${event.id}@elsewhere.test`));
    await f.deliver(ics(cancelled.uid));
    await f.deliver(ics(event.uid, { extra: ['RECURRENCE-ID:20300309T140000Z'] }));
    await f.deliver(ics(event.uid, { partstat: 'DELEGATED' }));
    for (const id of [event.id, others.id, cancelled.id]) expect(await f.response(id)).toBe('needs-action');
    expect(f.delivered()).toBe(8);
  });

  it('ignores a reply that arrives as our automatic forward, but applies one a calendar app marked auto-generated', async () => {
    const f = fixture(), event = await f.make();
    await f.deliver(ics(event.uid), { headers: 'X-RWA-Auto-Forwarded: 1\r\nAuto-Submitted: auto-generated\r\n', automated: true });
    expect(await f.response(event.id)).toBe('needs-action');
    await f.deliver(ics(event.uid), { headers: 'Auto-Submitted: auto-generated\r\n', automated: true });
    expect(await f.response(event.id)).toBe('accepted');
    expect(f.delivered()).toBe(2);
  });

  it('does not log invitations and cancellations as failed replies', async () => {
    const f = fixture(), event = await f.make();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await f.deliver(ics(event.uid, { method: 'REQUEST' }));
    await f.deliver(ics(event.uid, { method: 'CANCEL' }));
    expect(f.delivered()).toBe(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('still delivers the mail when the calendar part cannot be parsed or applied', async () => {
    const f = fixture(), event = await f.make();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await f.deliver('BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nthis is not ical');
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('SELECT * FROM calendar_events')) throw new Error('D1 unavailable');
      return prepare(sql);
    });
    await f.deliver(ics(event.uid));
    expect(f.delivered()).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
