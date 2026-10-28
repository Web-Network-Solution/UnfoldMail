import { adminRoutes } from '../src/routes/admin';
import { validateMeeting, createJitsiMeeting } from '@email-service/shared';
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { testDatabase } from "./helpers/database";
import { contactRoutes } from "../src/routes/contacts";
import { calendarRoutes, calendarRsvpRoutes } from "../src/routes/calendar";
import {
  dispatchCalendar,
  getEvent,
  nextReminder,
} from "../src/services/calendar";
import {
  validateCalendar,
  occurrences,
  calendarFile,
  parseCalendarFile,
  contactFile,
  parseContacts,
  type CalendarInput,
  type CalendarEvent,
} from "@email-service/shared/productivity";
import type { Env, HonoVariables, SendEmailMessage } from "../src/types";

const fixtures: ReturnType<typeof testDatabase>[] = [];
function fixture() {
  const database = testDatabase();
  fixtures.push(database);
  database.sqlite.exec(
    "INSERT INTO users(id,email,display_name,password_hash,role) VALUES('other','other@example.com','Other','h','employee')",
  );
  let user = "u";
  const send = vi.fn(async (_message: SendEmailMessage) => ({
    messageId: "test",
  }));
  const env = { MAILBOX_USER_ID: 'u',
    DB: database.db,
    EMAIL_BUCKET: { put: vi.fn(async () => undefined) },
    SEND_EMAIL: { send },
    EMAIL_DOMAIN: "example.com",
    APP_URL: "https://mail.example.com",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", user);
    c.set(
      "userEmail",
      user === "u" ? "employee@example.com" : "other@example.com",
    );
    c.set("userRole", "employee");
    await next();
  });
  app.route("/contacts", contactRoutes);
  app.route("/calendar", calendarRoutes);
  app.route("/rsvp", calendarRsvpRoutes);
  const request = (path: string, method = "GET", data?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
      env,
    );
  return {
    database,
    env,
    send,
    request,
    as: (id: string) => {
      user = id;
    },
  };
}
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.sqlite.close());
  vi.useRealTimers();
});
const contact = {
  name: "Asha Sharma",
  email: "asha@example.com",
  phone: "+91 1234567890",
  company: "Accounts",
  notes: "Private note",
  groups: ["Finance"],
};
const input = (v: Partial<CalendarInput> = {}): CalendarInput => ({
  title: "Planning",
  description: "Quarterly review",
  location: "Office",
  start: "2030-03-09T14:00:00.000Z",
  end: "2030-03-09T15:00:00.000Z",
  timezone: "America/New_York",
  allDay: false,
  recurrence: "",
  attendees: [],
  reminderMinutes: 15,
  ...v,
});
const event = (v: Partial<CalendarEvent> = {}): CalendarEvent => ({
  ...input(),
  id: "e",
  uid: "e@example.com",
  ownerId: "u",
  organizer: "employee@example.com",
  revision: 1,
  status: "confirmed",
  responses: [],
  excludedDates: [],
  ...v,
});

describe("Contacts integration", () => {
  it("excludes privileged accounts from the employee directory and directory suggestions", async () => {
    const f = fixture();
    f.database.sqlite.exec("INSERT INTO users(id,email,display_name,password_hash,role) VALUES ('admin','admin@example.com','Admin','h','admin'),('super','super@example.com','Super','h','super_admin')");
    for (const path of ['/contacts/directory','/contacts/directory?q=admin','/contacts/directory?q=super','/contacts/suggest?q=example.com']) {
      const result = await (await f.request(path)).json<{data:any}>();
      const entries = Array.isArray(result.data) ? result.data : result.data.contacts;
      expect(entries.some((e: {email:string}) => ['admin@example.com','super@example.com'].includes(e.email))).toBe(false);
      if (!path.includes('q=admin') && !path.includes('q=super')) expect(entries.some((e: {email:string}) => e.email==='other@example.com')).toBe(true);
    }
  });
  it("enforces privacy, revision conflicts, search, directory field minimization, and compose suggestions", async () => {
    const f = fixture();
    const made = await (
      await f.request("/contacts", "POST", contact)
    ).json<{ success: boolean; data: any }>();
    expect(made.data.revision).toBe(1);
    expect(
      (
        await (
          await f.request("/contacts?q=asha&group=Finance")
        ).json<{ success: boolean; data: any }>()
      ).data.total,
    ).toBe(1);
    expect(
      (
        await (
          await f.request("/contacts/suggest?q=asha")
        ).json<{ success: boolean; data: any }>()
      ).data[0].email,
    ).toBe(contact.email);
    expect(
      (
        await f.request(`/contacts/${made.data.id}`, "PUT", {
          ...contact,
          name: "Updated",
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(`/contacts/${made.data.id}`, "PUT", {
          ...contact,
          revision: 1,
        })
      ).status,
    ).toBe(409);
    f.as("other");
    expect(
      (
        await (
          await f.request("/contacts")
        ).json<{ success: boolean; data: any }>()
      ).data.total,
    ).toBe(0);
    expect(
      (
        await (
          await f.request("/contacts/suggest?q=asha")
        ).json<{ success: boolean; data: any }>()
      ).data,
    ).toEqual([]);
    expect(
      (
        await f.request(`/contacts/${made.data.id}`, "PUT", {
          ...contact,
          revision: 2,
        })
      ).status,
    ).toBe(409);
    await f.request(`/contacts/${made.data.id}`, "DELETE");
    f.as("u");
    expect(
      (
        await (
          await f.request("/contacts")
        ).json<{ success: boolean; data: any }>()
      ).data.total,
    ).toBe(1);
    const directory = await (
      await f.request("/contacts/directory")
    ).json<{ success: boolean; data: any }>();
    expect(JSON.stringify(directory)).not.toMatch(
      /password_hash|must_reset_password|"role"/,
    );
  });
  it("roundtrips CSV and vCard, handles escaped values, deduplicates imports and neutralizes spreadsheet formulas", async () => {
    for (const format of ["csv", "vcf"] as const) {
      const original = {
        ...contact,
        name: 'Asha, "Finance"',
        notes: "Line one\nLine two",
      };
      const output = contactFile([original], format);
      const parsed = parseContacts(output, format);
      expect(parsed[0]).toEqual(original);
    }
    expect(
      contactFile([{ ...contact, name: '=HYPERLINK("bad")' }], "csv"),
    ).toContain("'=HYPERLINK");
    const f = fixture(),
      body = { content: contactFile([contact, contact], "csv"), format: "csv" };
    expect(
      (
        await (
          await f.request("/contacts/import", "POST", body)
        ).json<{ success: boolean; data: any }>()
      ).data,
    ).toEqual({ imported: 1, skipped: 1 });
    expect(
      (
        await (
          await f.request("/contacts/import", "POST", body)
        ).json<{ success: boolean; data: any }>()
      ).data,
    ).toEqual({ imported: 0, skipped: 2 });
  });
  it("rejects invalid import atomically without touching existing data", async () => {
    const f = fixture();
    await f.request("/contacts", "POST", contact);
    expect(
      (
        await f.request("/contacts/import", "POST", {
          format: "csv",
          content: "name,email\nValid,valid@example.com\nInvalid,broken",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await (
          await f.request("/contacts")
        ).json<{ success: boolean; data: any }>()
      ).data.total,
    ).toBe(1);
  });
});
describe("Calendar integration", () => {
  it("creates invitations atomically, keeps tokens private, and isolates users", async () => {
    const f = fixture();
    const made = await (
      await f.request(
        "/calendar",
        "POST",
        input({ attendees: ["guest@external.test"] }),
      )
    ).json<{ success: boolean; data: any }>();
    expect(made.success).toBe(true);
    const id = made.data.id;
    expect((await getEvent(f.env, id))?.attendees).toEqual([
      "guest@external.test",
    ]);
    expect(
      f.database.sqlite
        .prepare("SELECT COUNT(*) n FROM calendar_deliveries")
        .get()?.n,
    ).toBe(1);
    expect(
      JSON.stringify(
        await (
          await f.request(`/calendar/${id}`)
        ).json<{ success: boolean; data: any }>(),
      ),
    ).not.toContain("token");
    f.as("other");
    expect((await f.request(`/calendar/${id}`)).status).toBe(404);
    expect(
      (await f.request(`/calendar/${id}`, "PUT", { ...input(), revision: 1 }))
        .status,
    ).toBe(404);
    expect(
      (
        await (
          await f.request(
            "/calendar?from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00Z",
          )
        ).json<{ success: boolean; data: any }>()
      ).data,
    ).toEqual([]);
  });
  it("rejects stale saves without altering attendee tokens or adding jobs", async () => {
    const f = fixture(),
      made = await (
        await f.request(
          "/calendar",
          "POST",
          input({ attendees: ["guest@external.test"] }),
        )
      ).json<{ success: boolean; data: any }>();
    expect(
      (
        await f.request(`/calendar/${made.data.id}`, "PUT", {
          ...input({ title: "Updated", attendees: ["other@example.com"] }),
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(`/calendar/${made.data.id}`, "PUT", {
          ...input({ title: "Stale" }),
          revision: 1,
        })
      ).status,
    ).toBe(409);
    const e = await getEvent(f.env, made.data.id);
    expect(e?.title).toBe("Updated");
    expect(e?.attendees).toEqual(["other@example.com"]);
  });
  it("external RSVP requires a token, updates status, sends one notification for repeated response, and invalidates old links on edit", async () => {
    const f = fixture(),
      made = await (
        await f.request(
          "/calendar",
          "POST",
          input({ attendees: ["guest@external.test"] }),
        )
      ).json<{ success: boolean; data: any }>();
    const row = f.database.sqlite
      .prepare("SELECT payload FROM calendar_deliveries")
      .get();
    const payload = JSON.parse(String(row?.payload));
    const token = payload.text.match(/respond#([a-f0-9-]+)/)[1];
    const preview = await (
      await f.request("/rsvp", "POST", { token })
    ).json<{ success: boolean; data: any }>();
    expect(preview.data.email).toBe("guest@external.test");
    expect(preview.data.response).toBe("needs-action");
    await f.request("/rsvp", "POST", { token, response: "accepted" });
    await f.request("/rsvp", "POST", { token, response: "accepted" });
    expect((await getEvent(f.env, made.data.id))?.responses[0].response).toBe(
      "accepted",
    );
    expect(
      f.database.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM calendar_deliveries WHERE kind='response'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      (await f.request("/rsvp", "POST", { token: "x".repeat(72) })).status,
    ).toBe(404);
    await f.request(`/calendar/${made.data.id}`, "PUT", {
      ...input({ attendees: ["guest@external.test"] }),
      revision: 1,
    });
    expect((await f.request("/rsvp", "POST", { token })).status).toBe(404);
  });
  it("internal attendees see invitations, can respond, cannot change organizer events, cancellation removes calendar occurrence", async () => {
    const f = fixture(),
      made = await (
        await f.request(
          "/calendar",
          "POST",
          input({ attendees: ["other@example.com"] }),
        )
      ).json<{ success: boolean; data: any }>();
    f.as("other");
    expect(
      (
        await (
          await f.request(
            "/calendar?from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00Z",
          )
        ).json<{ success: boolean; data: any }>()
      ).data,
    ).toHaveLength(1);
    expect(
      (
        await f.request(`/calendar/${made.data.id}/respond`, "POST", {
          response: "tentative",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(`/calendar/${made.data.id}/cancel`, "POST", {
          revision: 1,
        })
      ).status,
    ).toBe(404);
    f.as("u");
    expect(
      (
        await f.request(`/calendar/${made.data.id}/cancel`, "POST", {
          revision: 1,
        })
      ).status,
    ).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.status).toBe("cancelled");
    expect(
      (
        await (
          await f.request(
            "/calendar?from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00Z",
          )
        ).json<{ success: boolean; data: any }>()
      ).data,
    ).toEqual([]);
  });
  it("preserves local time across daylight saving and skips cancelled occurrences", () => {
    const e = event({ recurrence: "FREQ=DAILY;COUNT=3" }),
      all = occurrences(e, "2030-03-09T00:00:00Z", "2030-03-13T00:00:00Z");
    expect(all.map((o) => o.occurrenceStart)).toEqual([
      "2030-03-09T14:00:00.000Z",
      "2030-03-10T13:00:00.000Z",
      "2030-03-11T13:00:00.000Z",
    ]);
    expect(
      occurrences(
        { ...e, excludedDates: [all[1].occurrenceStart!] },
        "2030-03-09T00:00:00Z",
        "2030-03-13T00:00:00Z",
      ),
    ).toHaveLength(2);
  });
  it("roundtrips basic ICS, keeps all-day exclusive end, rejects unsafe recurrence and unsupported imports", () => {
    const e = event({
      allDay: true,
      start: "2030-04-01T00:00:00.000Z",
      end: "2030-04-02T00:00:00.000Z",
      title: "Plan, review; discuss\nNext line",
    });
    const ics = calendarFile([e]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20300401");
    const parsed = parseCalendarFile(ics, "UTC");
    expect(parsed[0].title).toBe(e.title);
    expect(parsed[0].end).toBe(e.end);
    expect(() =>
      validateCalendar(input({ recurrence: "FREQ=SECONDLY;COUNT=1000" })),
    ).toThrow();
    expect(() =>
      validateCalendar(input({ recurrence: "FREQ=DAILY" })),
    ).toThrow();
  });
  it("roundtrips recurring exports with timezone and excluded dates", () => {
    const e = event({
      recurrence: "FREQ=DAILY;COUNT=3",
      excludedDates: ["2030-03-10T13:00:00.000Z"],
    });
    const imported = parseCalendarFile(calendarFile([e]), "Asia/Kolkata")[0];
    expect(imported.timezone).toBe("America/New_York");
    expect(imported.recurrence).toBe(e.recurrence);
    expect(imported.excludedDates).toEqual(e.excludedDates);
  });
  it("supports group suggestions without exposing another user’s private contacts", async () => {
    const f = fixture();
    await f.request("/contacts", "POST", contact);
    const suggestions = await (
      await f.request("/contacts/suggest?q=Finance")
    ).json<{ data: { name: string; email: string }[] }>();
    expect(
      suggestions.data.some(
        (r) => r.name.includes("(group") && r.email === contact.email,
      ),
    ).toBe(true);
    f.as("other");
    expect(
      (
        await (
          await f.request("/contacts/suggest?q=Finance")
        ).json<{ data: unknown[] }>()
      ).data,
    ).toEqual([]);
  });
  it("materializes legacy calendar attachments as UTF-8 bytes with required disposition", async () => {
    const f = fixture();
    await f.request("/calendar", "POST", input({ title: "Team café", attendees: ["guest@external.test"] }));
    const row = f.database.sqlite.prepare("SELECT id,payload FROM calendar_deliveries").get()!;
    const legacy = JSON.parse(row.payload as string);
    delete legacy.attachments[0].disposition;
    f.database.sqlite.prepare("UPDATE calendar_deliveries SET payload=? WHERE id=?").run(JSON.stringify(legacy), row.id);
    await dispatchCalendar(f.env);
    const part = f.send.mock.calls[0][0].attachments![0];
    expect(part.disposition).toBe("attachment");
    expect(part.content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(part.content as Uint8Array)).toBe(legacy.attachments[0].content);
    expect(new TextDecoder().decode(part.content as Uint8Array)).toContain("Team café");
    expect(f.database.sqlite.prepare("SELECT payload,status FROM calendar_deliveries").get()).toMatchObject({payload: JSON.stringify(legacy), status: "sent"});
  });
  it("explains unverified organizer domains without exposing provider payloads", async () => {
    const f = fixture();
    await f.request("/calendar", "POST", input({attendees: ["guest@external.test"]}));
    f.send.mockRejectedValueOnce(Object.assign(new Error("sensitive provider details"), {code: "E_SENDER_NOT_VERIFIED"}));
    await dispatchCalendar(f.env);
    const row = f.database.sqlite.prepare("SELECT status,error FROM calendar_deliveries").get()!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("domain is not verified");
    expect(row.error).not.toContain("sensitive");
  });
  it("persists delivered invitations in Sent and FTS exactly once with calendar attachments", async () => {
    const f = fixture();
    await f.request(
      "/calendar",
      "POST",
      input({ attendees: ["guest@external.test"] }),
    );
    await dispatchCalendar(f.env);
    await dispatchCalendar(f.env);
    const mail = f.database.sqlite
      .prepare(
        "SELECT id,subject,delivery_status FROM emails WHERE folder_id='sent'",
      )
      .all();
    expect(mail).toHaveLength(1);
    expect(mail[0].delivery_status).toBe("sent");
    expect(
      f.database.sqlite
        .prepare("SELECT filename FROM attachments WHERE email_id=?")
        .get(mail[0].id)?.filename,
    ).toBe("invitation.ics");
    expect(
      f.database.sqlite
        .prepare("SELECT COUNT(*) n FROM emails_fts WHERE email_id=?")
        .get(mail[0].id)?.n,
    ).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it("cancels one occurrence without cancelling the series and makes full cancellations inspectable", async () => {
    const f = fixture(),
      made = await (
        await f.request(
          "/calendar",
          "POST",
          input({ recurrence: "FREQ=DAILY;COUNT=3" }),
        )
      ).json<{ data: CalendarEvent }>();
    expect(
      (
        await f.request(`/calendar/${made.data.id}/cancel`, "POST", {
          revision: 1,
          occurrence: "2030-03-10T13:00:00.000Z",
        })
      ).status,
    ).toBe(200);
    const range = "/calendar?from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00Z";
    expect(
      (await (await f.request(range)).json<{ data: CalendarEvent[] }>()).data,
    ).toHaveLength(2);
    await f.request(`/calendar/${made.data.id}/cancel`, "POST", {
      revision: 2,
    });
    expect(
      (
        await (
          await f.request(range + "&cancelled=true")
        ).json<{ data: CalendarEvent[] }>()
      ).data[0].status,
    ).toBe("cancelled");
  });
  it("does not resend after provider acceptance when saving the Sent copy fails", async () => {
    const f = fixture();
    await f.request(
      "/calendar",
      "POST",
      input({ attendees: ["guest@external.test"] }),
    );
    vi.mocked(f.env.EMAIL_BUCKET.put).mockRejectedValueOnce(
      new Error("R2 temporarily unavailable"),
    );
    await dispatchCalendar(f.env);
    expect(
      f.database.sqlite
        .prepare("SELECT status,sent_copy_saved FROM calendar_deliveries")
        .get(),
    ).toMatchObject({ status: "sent", sent_copy_saved: 0 });
    f.database.sqlite.exec("UPDATE calendar_deliveries SET next_attempt_at='2000-01-01'"); // skip the copy backoff
    await dispatchCalendar(f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(
      f.database.sqlite
        .prepare("SELECT sent_copy_saved FROM calendar_deliveries")
        .get()?.sent_copy_saved,
    ).toBe(1);
  });
  it("dispatches saved jobs once, retries explicit temporary rejection, and marks ambiguous results uncertain", async () => {
    const f = fixture();
    await f.request(
      "/calendar",
      "POST",
      input({ attendees: ["guest@external.test"] }),
    );
    f.send.mockRejectedValueOnce(
      Object.assign(new Error("Busy"), { code: "E_RATE_LIMIT_EXCEEDED" }),
    );
    await dispatchCalendar(f.env);
    expect(
      f.database.sqlite.prepare("SELECT status FROM calendar_deliveries").get()
        ?.status,
    ).toBe("queued");
    f.database.sqlite.exec(
      "UPDATE calendar_deliveries SET next_attempt_at='2000-01-01'",
    );
    await dispatchCalendar(f.env);
    await dispatchCalendar(f.env);
    expect(f.send).toHaveBeenCalledTimes(2);
    await f.request(
      "/calendar",
      "POST",
      input({ attendees: ["guest@external.test"] }),
    );
    f.send.mockRejectedValueOnce(new Error("Connection lost"));
    await dispatchCalendar(f.env);
    expect(
      f.database.sqlite
        .prepare(
          "SELECT COUNT(*) n FROM calendar_deliveries WHERE status='uncertain'",
        )
        .get()?.n,
    ).toBe(1);
  });
  it("schedules reminders once and advances recurring reminders", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    await f.request(
      "/calendar",
      "POST",
      input({ recurrence: "FREQ=DAILY;COUNT=3" }),
    );
    expect(nextReminder(event(), Date.now())).toBe("2030-03-09T13:45:00.000Z");
    vi.setSystemTime(new Date("2030-03-09T13:46:00Z"));
    await dispatchCalendar(f.env);
    await dispatchCalendar(f.env);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(
      f.database.sqlite
        .prepare("SELECT next_reminder_at FROM calendar_events")
        .get()?.next_reminder_at,
    ).toBe("2030-03-10T12:45:00.000Z");
  });
  it("keeps foreign keys intact and cascades account deletion", async () => {
    const f = fixture();
    await f.request("/contacts", "POST", contact);
    await f.request(
      "/calendar",
      "POST",
      input({ attendees: ["guest@external.test"] }),
    );
    f.database.sqlite.exec("DELETE FROM users WHERE id='u'");
    for (const table of [
      "contacts",
      "calendar_events",
      "calendar_attendees",
      "calendar_deliveries",
    ])
      expect(
        f.database.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n,
      ).toBe(0);
    expect(f.database.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
  });
});

describe("Calendar import transactions and export bounds", () => {
  it("rolls back the entire import if a later event cannot be saved", async () => {
    const f = fixture();
    f.database.sqlite.exec("CREATE TRIGGER reject_test_event BEFORE INSERT ON calendar_events WHEN NEW.title='Reject me' BEGIN SELECT RAISE(ABORT,'Injected write failure'); END");
    const response = await f.request('/calendar/import', 'POST', {content: calendarFile([event(), event({id:'second',uid:'second@example.com',title:'Reject me'})]), timezone:'UTC'});
    expect(response.status).toBe(500);
    expect(f.database.sqlite.prepare('SELECT COUNT(*) n FROM calendar_events').get()?.n).toBe(0);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("exports all-day recurrence as dates and bounds bulk expansion", () => {
    const e = event({allDay:true,start:'2030-03-09T00:00:00.000Z',end:'2030-03-10T00:00:00.000Z',timezone:'UTC',recurrence:'FREQ=DAILY;COUNT=3'});
    expect(calendarFile([e])).toContain('RDATE;VALUE=DATE:');
    expect(parseCalendarFile(calendarFile([e]), 'UTC')[0].allDay).toBe(true);
    expect(() => calendarFile(Array.from({length:11}, () => event({recurrence:'FREQ=DAILY;COUNT=1000'})))).toThrow('10,000 occurrences');
  });
});

describe('Calendar online meetings', () => {
  it('validates provider URLs and rejects unsafe or misleading links', () => {
    for (const [provider,url] of [['zoom','https://company.zoom.us/j/123?pwd=test'],['google-meet','https://meet.google.com/abc-defg-hij'],['teams','https://teams.microsoft.com/l/meetup-join/test'],['jitsi','https://meet.jit.si/test-room'],['jitsi','https://video.example.com/room']] as const) expect(validateMeeting({provider,url})?.provider).toBe(provider);
    for (const url of ['javascript:alert(1)','http://meet.google.com/a','https://meet.google.com.evil.test/a','https://user:pass@meet.google.com/a','https://meet.google.com/']) expect(()=>validateMeeting({provider:'google-meet',url})).toThrow();
    expect(()=>validateMeeting({provider:'unknown',url:'https://example.com/a'})).toThrow();
    const a=createJitsiMeeting(),b=createJitsiMeeting();expect(a.url).not.toBe(b.url);expect(validateMeeting(a)).toEqual(a);
  });
  it('persists meetings, includes links in invitations and guest responses, and removes them on edit', async () => {
    const f=fixture(); const meeting={provider:'google-meet',url:'https://meet.google.com/abc-defg-hij'};
    const res=await f.request('/calendar','POST',input({meeting:meeting as any,attendees:['guest@external.test']}));
    expect(res.status).toBe(201);
    const e=(await res.json<{data:CalendarEvent}>()).data;
    expect((await getEvent(f.env,e.id))?.meeting).toEqual(meeting);
    const payload=JSON.parse(String(f.database.sqlite.prepare('SELECT payload FROM calendar_deliveries').get()?.payload));
    expect(payload.text).toContain(meeting.url);
    const token=payload.text.match(/respond#([a-f0-9-]{72})/)[1];
    const guest=await (await f.request('/rsvp','POST',{token})).json<{data:CalendarEvent}>();expect(guest.data.meeting).toEqual(meeting);
    expect((await f.request(`/calendar/${e.id}`,'PUT',{...input(),meeting:null,revision:e.revision})).status).toBe(200);
    expect((await getEvent(f.env,e.id))?.meeting).toBeNull();
  });
  it('roundtrips meeting metadata in ICS without duplicating the description', () => {
    const e=event({meeting:createJitsiMeeting()});
    const file=calendarFile([e]);expect(file).toContain('X-RWA-MEETING-PROVIDER:jitsi');
    const imported=parseCalendarFile(file,'UTC')[0];expect(imported.meeting).toEqual(e.meeting);expect(imported.description).toBe(e.description);
    expect(parseCalendarFile(calendarFile([event(imported)]),'UTC')[0].description).toBe(e.description);
  });
});

describe('Organization meeting policy', () => {
  it('blocks disabled providers on create and import, preserves existing links, and allows their removal', async () => {
    const f = fixture();
    const meeting = {provider:'jitsi' as const,url:'https://meet.jit.si/test-policy'};
    const made = await (await f.request('/calendar','POST',input({meeting}))).json<{data:CalendarEvent}>();
    f.database.sqlite.prepare("INSERT INTO settings(key,value) VALUES('meeting_providers','[]')").run();
    expect((await (await f.request('/calendar/providers')).json<{data:string[]}>()).data).toEqual([]);
    const rejected = await f.request('/calendar','POST',input({meeting}));
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect((await rejected.json<{error:string}>()).error).toContain('disabled');
    const imported = await f.request('/calendar/import','POST',{content:calendarFile([{...made.data,id:'new',uid:'new@example.com'}]),timezone:'UTC'});
    expect(imported.status).toBe(400);
    expect(f.database.sqlite.prepare('SELECT COUNT(*) n FROM calendar_events').get()?.n).toBe(1);
    expect((await f.request('/calendar/'+made.data.id,'PUT',{...input({meeting}),revision:1})).status).toBe(200);
    expect((await f.request('/calendar/'+made.data.id,'PUT',{...input({meeting:{...meeting,url:'https://meet.jit.si/other'}}),revision:2})).status).toBeGreaterThanOrEqual(400);
    expect((await f.request('/calendar/'+made.data.id,'PUT',{...input({meeting:null}),revision:2})).status).toBe(200);
  });
  it('restricts retention and meeting policy APIs to super admins and persists valid choices', async () => {
    const f=fixture();
    let role: 'employee'|'admin'|'super_admin' = 'employee';
    const app=new Hono<{Bindings:Env;Variables:HonoVariables}>();
    app.use('*',async(c,next)=>{c.set('userRole',role);await next();});
    app.route('/admin',adminRoutes);
    const req=(path:string,method='GET',body?:unknown)=>app.request('/admin/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},f.env);
    for (const r of ['employee','admin'] as const) {
      role=r;
      for (const path of ['retention','meeting-providers']) {
        expect((await req(path)).status).toBe(403);
        expect((await req(path,'PUT',{})).status).toBe(403);
      }
    }
    role='super_admin';
    expect((await req('retention')).status).toBe(200);
    expect((await req('retention','PUT',{archiveAfterDays:730,deleteTrashAfterDays:60})).status).toBe(200);
    expect((await req('meeting-providers','PUT',{providers:['unknown']})).status).toBe(400);
    expect((await req('meeting-providers','PUT',{providers:['zoom','zoom']})).status).toBe(400);
    expect((await req('meeting-providers','PUT',{providers:['zoom']})).status).toBe(200);
    expect((await (await f.request('/calendar/providers')).json<{data:string[]}>()).data).toEqual(['zoom']);
    expect((await req('meeting-providers','PUT',{providers:[]})).status).toBe(200);
  });
});
