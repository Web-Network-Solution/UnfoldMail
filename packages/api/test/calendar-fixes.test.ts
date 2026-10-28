import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { testDatabase } from "./helpers/database";
import { contactRoutes } from "../src/routes/contacts";
import { calendarRoutes, calendarRsvpRoutes } from "../src/routes/calendar";
import { calendarLimitMessage, dispatchCalendar, getEvent, saveEvent } from "../src/services/calendar";
import { calendarFile, instantFromWall, occurrences, seriesSlots, type CalendarEvent, type CalendarInput } from "@email-service/shared/productivity";
import type { Env, HonoVariables } from "../src/types";

const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => { fixtures.splice(0).forEach((f) => f.sqlite.close()); });
function fixture() {
  const database = testDatabase();
  fixtures.push(database);
  const send = vi.fn(async () => ({ messageId: "test" }));
  const env = { MAILBOX_USER_ID: "u", DB: database.db, EMAIL_BUCKET: { put: vi.fn(async () => undefined) }, SEND_EMAIL: { send }, EMAIL_DOMAIN: "example.com", APP_URL: "https://mail.example.com" } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => { c.set("userId", "u"); c.set("userEmail", "employee@example.com"); c.set("userRole", "employee"); await next(); });
  app.route("/contacts", contactRoutes);
  app.route("/calendar", calendarRoutes);
  app.route("/rsvp", calendarRsvpRoutes);
  const request = (path: string, method = "GET", data?: unknown) =>
    app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, env);
  return { database, env, send, request };
}
// Daily at 09:00 New York, across the March 2030 DST change.
const input = (v: Partial<CalendarInput> = {}): CalendarInput => ({ title: "Planning", description: "", location: "", start: "2030-03-09T14:00:00.000Z", end: "2030-03-09T15:00:00.000Z", timezone: "America/New_York", allDay: false, recurrence: "FREQ=DAILY;COUNT=3", attendees: ["guest@external.test", "other@example.com"], reminderMinutes: null, ...v });
const event = (v: Partial<CalendarEvent>): CalendarEvent => ({ ...input(), id: "e", uid: "e@example.com", ownerId: "u", organizer: "employee@example.com", revision: 1, status: "confirmed", responses: [], excludedDates: [], ...v });
const json = async <T = any>(r: Response | Promise<Response>) => (await (await r).json()) as { success: boolean; data: T; error: string };
const response = async (f: ReturnType<typeof fixture>, id: string, email: string) => (await getEvent(f.env, id))?.responses.find((r) => r.email === email)?.response;
function fill(f: ReturnType<typeof fixture>, from: number, to: number) {
  f.database.sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT ${from} UNION ALL SELECT i+1 FROM n WHERE i<${to})
    INSERT INTO calendar_events(id,owner_id,uid,organizer,title,start_at,end_at,series_end_at,timezone,created_at,updated_at)
    SELECT 'fill'||i,'u','fill'||i||'@x','employee@example.com','Fill','2030-01-01T00:00:00.000Z','2030-01-01T01:00:00.000Z','2030-01-01T01:00:00.000Z','UTC','2030-01-01','2030-01-01' FROM n`);
}

describe("Calendar attendee responses survive edits (D1)", () => {
  it("keeps responses across non-schedule edits and occurrence cancels, resets them when the schedule changes", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input()));
    const token = JSON.parse(String(f.database.sqlite.prepare("SELECT payload FROM calendar_deliveries WHERE recipient='guest@external.test'").get()?.payload)).text.match(/respond#([a-f0-9-]{72})/)[1];
    expect((await f.request("/rsvp", "POST", { token, response: "accepted" })).status).toBe(200);
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ title: "Typo fixed" }), revision: 1 })).status).toBe(200);
    expect(await response(f, made.data.id, "guest@external.test")).toBe("accepted");
    expect((await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 2, occurrence: "2030-03-10T13:00:00.000Z" })).status).toBe(200);
    expect(await response(f, made.data.id, "guest@external.test")).toBe("accepted");
    expect((await f.request("/rsvp", "POST", { token })).status).toBe(404); // links still rotate
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ attendees: ["guest@external.test"] }), revision: 3 })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.attendees).toEqual(["guest@external.test"]);
    expect(await response(f, made.data.id, "guest@external.test")).toBe("accepted");
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ start: "2030-03-09T15:00:00.000Z", end: "2030-03-09T16:00:00.000Z", attendees: ["guest@external.test"] }), revision: 4 })).status).toBe(200);
    expect(await response(f, made.data.id, "guest@external.test")).toBe("needs-action");
  });
});

describe("Calendar exclusions (D2, D4)", () => {
  it("keeps exclusions when a PUT omits them and clears them on an explicit empty list", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ attendees: [] })));
    await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 1, occurrence: "2030-03-10T13:00:00.000Z" });
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ title: "Renamed", attendees: [] }), revision: 2 })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.excludedDates).toEqual(["2030-03-10T13:00:00.000Z"]);
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ attendees: [], excludedDates: [] }), revision: 3 })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.excludedDates).toEqual([]);
  });
  it("moves exclusions with the series when its start changes and drops those past the new end", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ attendees: [] })));
    await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 1, occurrence: "2030-03-10T13:00:00.000Z" });
    const old = (await getEvent(f.env, made.data.id))!;
    // The web editor sends the loaded event, including the old exclusion instants.
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...old, start: "2030-03-09T15:00:00.000Z", end: "2030-03-09T16:00:00.000Z" })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.excludedDates).toEqual(["2030-03-10T14:00:00.000Z"]);
    const range = "/calendar?from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00Z";
    expect((await json<CalendarEvent[]>(f.request(range))).data.map((e) => e.occurrenceStart)).toEqual(["2030-03-09T15:00:00.000Z", "2030-03-11T14:00:00.000Z"]);
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ attendees: [], start: "2030-03-09T15:00:00.000Z", end: "2030-03-09T16:00:00.000Z", recurrence: "FREQ=DAILY;COUNT=1" }), revision: 3 })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.excludedDates).toEqual([]);
  });
});

describe("DST fall-back occurrences (D3)", () => {
  it("resolves the repeated hour to the earlier instant and still skips nonexistent times", () => {
    expect(() => instantFromWall("2030-11-03T01:30", "America/New_York")).toThrow();
    expect(instantFromWall("2030-11-03T01:30", "America/New_York", "earlier")).toBe("2030-11-03T05:30:00Z");
    expect(() => instantFromWall("2030-03-10T02:30", "America/New_York", "earlier")).toThrow();
    const fall = event({ start: "2030-11-01T05:30:00.000Z", end: "2030-11-01T06:00:00.000Z", recurrence: "FREQ=DAILY;COUNT=4" });
    expect(occurrences(fall, "2030-10-01T00:00:00Z", "2030-12-01T00:00:00Z").map((o) => o.occurrenceStart)).toEqual(["2030-11-01T05:30:00.000Z", "2030-11-02T05:30:00.000Z", "2030-11-03T05:30:00.000Z", "2030-11-04T06:30:00.000Z"]);
    const spring = event({ start: "2030-03-09T07:30:00.000Z", end: "2030-03-09T08:00:00.000Z", recurrence: "FREQ=DAILY;COUNT=3" });
    expect(occurrences(spring, "2030-03-01T00:00:00Z", "2030-04-01T00:00:00Z").map((o) => o.occurrenceStart)).toEqual(["2030-03-09T07:30:00.000Z", "2030-03-11T06:30:00.000Z"]);
    // A series saved at the later 01:30 keeps its exact first occurrence.
    const later = event({ start: "2030-11-03T06:30:00.000Z", end: "2030-11-03T07:00:00.000Z", recurrence: "FREQ=DAILY;COUNT=2" });
    expect(occurrences(later, "2030-10-01T00:00:00Z", "2030-12-01T00:00:00Z").map((o) => o.occurrenceStart)).toEqual(["2030-11-03T06:30:00.000Z", "2030-11-04T06:30:00.000Z"]);
  });
});

describe("Exclusions across a DST gap (calendar-contacts-1)", () => {
  it("keeps one slot per rule date so a time edit moves exclusions to the same day", async () => {
    const spring = event({ start: "2030-03-09T07:30:00.000Z", end: "2030-03-09T08:00:00.000Z" });
    expect(seriesSlots(spring, spring.start, "2102-01-01T00:00:00.000Z").map((d) => d?.toISOString() ?? null)).toEqual(["2030-03-09T07:30:00.000Z", null, "2030-03-11T06:30:00.000Z"]);
    const f = fixture();
    // Daily at 02:30 New York; 02:30 on 2030-03-10 does not exist.
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ attendees: [], start: "2030-03-08T07:30:00.000Z", end: "2030-03-08T08:00:00.000Z", recurrence: "FREQ=DAILY;COUNT=5" })));
    expect((await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 1, occurrence: "2030-03-11T06:30:00.000Z" })).status).toBe(200);
    let old = (await getEvent(f.env, made.data.id))!;
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...old, start: "2030-03-08T08:30:00.000Z", end: "2030-03-08T09:00:00.000Z" })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.excludedDates).toEqual(["2030-03-11T07:30:00.000Z"]);
    // Back to 02:30: the exclusion on the missing day is dropped, the other stays on its day.
    expect((await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 3, occurrence: "2030-03-10T07:30:00.000Z" })).status).toBe(200);
    old = (await getEvent(f.env, made.data.id))!;
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...old, start: "2030-03-08T07:30:00.000Z", end: "2030-03-08T08:00:00.000Z" })).status).toBe(200);
    expect((await getEvent(f.env, made.data.id))?.excludedDates).toEqual(["2030-03-11T06:30:00.000Z"]);
  });
});

describe("Cancelled events stay cancelled (K8)", () => {
  it("rejects edits and a second cancellation with 409 and queues nothing", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", attendees: ["guest@external.test"] })));
    expect((await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 1 })).status).toBe(200);
    const deliveries = () => f.database.sqlite.prepare("SELECT id,kind,status FROM calendar_deliveries ORDER BY id").all();
    const before = deliveries();
    expect((await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 2 })).status).toBe(409);
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ recurrence: "", attendees: ["guest@external.test"] }), revision: 2 })).status).toBe(409);
    expect(deliveries()).toEqual(before);
    expect((await getEvent(f.env, made.data.id))?.status).toBe("cancelled");
  });
});

describe("Calendar error statuses (K4)", () => {
  it("returns 409 only for conflicts; storage errors are a generic 500 and a disabled provider is a 400", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ attendees: [] })));
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ attendees: [] }), revision: 7 })).status).toBe(409);
    const batch = vi.spyOn(f.env.DB, "batch").mockRejectedValue(new Error("D1_ERROR: UNIQUE constraint failed: calendar_attendees.token_hash: SQLITE_CONSTRAINT"));
    for (const res of [await f.request("/calendar", "POST", input()), await f.request(`/calendar/${made.data.id}`, "PUT", { ...input(), revision: 1 }), await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 1 })]) {
      expect(res.status).toBe(500);
      expect((await json(res)).error).toBe("Unable to complete calendar operation");
    }
    batch.mockRestore();
    f.database.sqlite.prepare("INSERT INTO settings(key,value) VALUES('meeting_providers','[]')").run();
    const meeting = { provider: "jitsi" as const, url: "https://meet.jit.si/k4-room" };
    expect((await f.request("/calendar", "POST", input({ meeting }))).status).toBe(400);
    expect((await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ meeting }), revision: 1 })).status).toBe(400);
    expect((await f.request("/calendar/import", "POST", { content: calendarFile([event({ recurrence: "", attendees: [], meeting })]), timezone: "UTC" })).status).toBe(400);
  });
  it("sends a failed provider-settings read to the generic 500, not a 400 carrying the storage text", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ attendees: [] })));
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    vi.spyOn(f.env.DB, "prepare").mockImplementation((sql: string) => sql.includes("meeting_providers") ? ({ first: async () => { throw new Error("D1_ERROR: storage offline"); } } as unknown as D1PreparedStatement) : prepare(sql));
    const meeting = { provider: "jitsi" as const, url: "https://meet.jit.si/k4-room" };
    for (const res of [await f.request("/calendar", "POST", input({ meeting })), await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ meeting }), revision: 1 }), await f.request("/calendar/import", "POST", { content: calendarFile([event({ recurrence: "", attendees: [], meeting })]), timezone: "UTC" })]) {
      expect(res.status).toBe(500);
      expect((await json(res)).error).toBe("Unable to complete calendar operation");
    }
  });
  it("reports the import pre-check with the same 409 and message as the trigger", async () => {
    const f = fixture();
    fill(f, 1, 5000);
    const res = await f.request("/calendar/import", "POST", { content: calendarFile([event({ recurrence: "", attendees: [] })]), timezone: "UTC" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(calendarLimitMessage);
  });
});

describe("Sent-copy persistence (D5)", () => {
  it("backs off failing copies so they cannot starve others, and gives up after bounded tries", async () => {
    const f = fixture();
    await f.request("/calendar", "POST", input({ recurrence: "", attendees: ["guest@external.test"] }));
    const eventId = String(f.database.sqlite.prepare("SELECT event_id FROM calendar_deliveries").get()?.event_id);
    const insert = f.database.sqlite.prepare("INSERT INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,status,attempts,next_attempt_at,created_at,updated_at,dedupe_key) VALUES(?,?,'u','x@example.com','invitation',?,'sent',1,'2029-01-01','2029-01-01','2029-01-01',?)");
    const payload = JSON.stringify({ from: "employee@example.com", to: "x@example.com", subject: "Stuck", text: "Stuck" });
    for (let i = 0; i < 30; i++) insert.run(`stuck-${i}`, eventId, payload, `stuck-${i}`);
    vi.mocked(f.env.EMAIL_BUCKET.put).mockImplementation(async (key: string) => { if (key.includes("/stuck-")) throw new Error("R2 rejects"); return undefined as never; });
    await dispatchCalendar(f.env);
    await dispatchCalendar(f.env);
    expect(f.database.sqlite.prepare("SELECT sent_copy_saved FROM calendar_deliveries WHERE id NOT LIKE 'stuck-%'").get()?.sent_copy_saved).toBe(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    f.database.sqlite.exec("UPDATE calendar_deliveries SET attempts=23,next_attempt_at='2000-01-01' WHERE id='stuck-0'");
    await dispatchCalendar(f.env);
    expect(f.database.sqlite.prepare("SELECT sent_copy_saved,error FROM calendar_deliveries WHERE id='stuck-0'").get()).toMatchObject({ sent_copy_saved: -1, error: expect.stringContaining("Sent") });
  });
});

describe("Calendar event limit (D6)", () => {
  it("reports the 5,000-event trigger as the friendly 409 on create", async () => {
    const f = fixture();
    fill(f, 1, 5000);
    const res = await f.request("/calendar", "POST", input({ attendees: [] }));
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(calendarLimitMessage);
  });
  it("reports the trigger as the friendly 409 when a concurrent write beats the import pre-check", async () => {
    const f = fixture();
    fill(f, 1, 4999);
    const batch = f.env.DB.batch.bind(f.env.DB);
    f.env.DB.batch = (async (statements: D1PreparedStatement[]) => { fill(f, 5000, 5000); return batch(statements); }) as typeof f.env.DB.batch;
    const res = await f.request("/calendar/import", "POST", { content: calendarFile([event({ recurrence: "", attendees: [] })]), timezone: "UTC" });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(calendarLimitMessage);
  });
});

describe("Contact deletion (D7)", () => {
  it("returns 404 when nothing was deleted", async () => {
    const f = fixture();
    const made = await json<{ id: string }>(f.request("/contacts", "POST", { name: "Asha", email: "asha@example.com", phone: "", company: "", notes: "", groups: [] }));
    expect((await f.request(`/contacts/${made.data.id}`, "DELETE")).status).toBe(200);
    expect((await f.request(`/contacts/${made.data.id}`, "DELETE")).status).toBe(404);
  });
});

describe("Reminders for internal attendees (C1)", () => {
  const people = "INSERT INTO users(id,email,display_name,password_hash,role) VALUES('other','other@example.com','Other','h','employee'),('no','declined@example.com','No','h','employee')";
  const reminders = (f: ReturnType<typeof fixture>) => f.database.sqlite.prepare("SELECT user_id,recipient,status,sent_copy_saved,payload FROM calendar_deliveries WHERE kind='reminder' ORDER BY recipient").all();
  afterEach(() => { vi.useRealTimers(); });
  it("sends each non-declined internal attendee a self-addressed reminder under their own account, with no Sent copies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    f.database.sqlite.exec(people);
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", reminderMinutes: 15, attendees: ["other@example.com", "declined@example.com", "guest@external.test"] })));
    f.database.sqlite.exec("UPDATE calendar_attendees SET response='declined' WHERE email='declined@example.com'");
    vi.setSystemTime(new Date("2030-03-09T13:46:00Z"));
    await dispatchCalendar(f.env);
    await dispatchCalendar(f.env);
    expect(reminders(f).map(({ payload, ...r }) => ({ ...r, from: JSON.parse(String(payload)).from, to: JSON.parse(String(payload)).to }))).toEqual([
      { user_id: "u", recipient: "employee@example.com", status: "sent", sent_copy_saved: 2, from: "employee@example.com", to: "employee@example.com" },
      { user_id: "other", recipient: "other@example.com", status: "sent", sent_copy_saved: 2, from: "other@example.com", to: "other@example.com" },
    ]);
    expect(f.send.mock.calls.filter(([m]: any) => m.subject.startsWith("Reminder:"))).toHaveLength(2);
    expect(f.database.sqlite.prepare("SELECT COUNT(*) n FROM emails WHERE subject LIKE 'Reminder:%'").get()?.n).toBe(0);
    expect((await getEvent(f.env, made.data.id))?.status).toBe("confirmed");
    // Sent reminders are purged after 30 days like any finished delivery.
    f.database.sqlite.exec("UPDATE calendar_deliveries SET updated_at='2029-01-01' WHERE kind='reminder'");
    await dispatchCalendar(f.env);
    expect(reminders(f)).toEqual([]);
  });
  it("skips a reminder more than a day late for every recipient", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    f.database.sqlite.exec(people);
    await f.request("/calendar", "POST", input({ recurrence: "", reminderMinutes: 15, attendees: ["other@example.com"] }));
    vi.setSystemTime(new Date("2030-03-10T14:00:00Z"));
    await dispatchCalendar(f.env);
    expect(reminders(f)).toEqual([]);
    expect(f.database.sqlite.prepare("SELECT next_reminder_at FROM calendar_events").get()?.next_reminder_at).toBeNull();
  });
  it("leaves out attendees who must reset their password, hides attendees' reminders from the organizer and purges failed ones", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    f.database.sqlite.exec(people);
    f.database.sqlite.exec("UPDATE users SET must_reset_password=1 WHERE id='other'");
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", reminderMinutes: 15, attendees: ["other@example.com"] })));
    vi.setSystemTime(new Date("2030-03-09T13:46:00Z"));
    await dispatchCalendar(f.env);
    expect(reminders(f).map((r) => [r.user_id, r.status])).toEqual([["u", "sent"]]);
    f.database.sqlite.prepare(`INSERT INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,status,next_attempt_at,created_at,updated_at,dedupe_key)
      VALUES('theirs',?,'other','other@example.com','reminder','{}','failed','2030-03-09','2030-03-09','2030-03-09','theirs'),('mine',?,'u','employee@example.com','reminder','{}','uncertain','2030-03-09','2030-03-09','2030-03-09','mine')`).run(made.data.id, made.data.id);
    const listed = await json<{ id: string; kind: string }[]>(f.request(`/calendar/${made.data.id}/deliveries`));
    expect(listed.data.filter((d) => d.kind === "reminder").map((d) => d.id)).toContain("mine");
    expect(listed.data.map((d) => d.id)).not.toContain("theirs");
    f.database.sqlite.exec("UPDATE calendar_deliveries SET updated_at='2029-01-01' WHERE kind='reminder'");
    await dispatchCalendar(f.env);
    expect(reminders(f)).toEqual([]);
  });
  it("sends reminders ahead of a backlog of other deliveries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", reminderMinutes: 15, attendees: [] })));
    const insert = f.database.sqlite.prepare("INSERT INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,next_attempt_at,created_at,updated_at,dedupe_key) VALUES(?,?,'u','x@example.com','invitation',?,'2030-03-09T12:00:00.000Z','2030-03-09T12:00:00.000Z','2030-03-09T12:00:00.000Z',?)");
    const payload = JSON.stringify({ from: "employee@example.com", to: "x@example.com", subject: "Backlog", text: "Backlog" });
    for (let i = 0; i < 30; i++) insert.run(`backlog-${i}`, made.data.id, payload, `backlog-${i}`);
    vi.setSystemTime(new Date("2030-03-09T13:46:00Z"));
    await dispatchCalendar(f.env);
    expect(f.send.mock.calls.filter(([m]: any) => m.subject.startsWith("Reminder:"))).toHaveLength(1);
  });
  it("cancels a reminder still queued when its occurrence starts and skips one whose occurrence already started", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", reminderMinutes: 15, attendees: [] })));
    f.database.sqlite.prepare("INSERT INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,next_attempt_at,created_at,updated_at,dedupe_key,sent_copy_saved) VALUES('late',?,'u','employee@example.com','reminder',?,'2030-03-09T13:45:00.000Z','2030-03-09T13:45:00.000Z','2030-03-09T13:45:00.000Z','late',2)")
      .run(made.data.id, JSON.stringify({ from: "employee@example.com", to: "employee@example.com", subject: "Reminder: Planning", text: "" }));
    vi.setSystemTime(new Date("2030-03-09T14:03:00Z"));
    await dispatchCalendar(f.env);
    expect(f.send).not.toHaveBeenCalled();
    expect(reminders(f).map((r) => [r.recipient, r.status])).toEqual([["employee@example.com", "cancelled"]]);
    expect(f.database.sqlite.prepare("SELECT next_reminder_at FROM calendar_events").get()?.next_reminder_at).toBeNull();
  });
  it("still sends an 'At start' reminder that is first picked up on the next tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-03-09T13:00:00Z"));
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", reminderMinutes: 0, attendees: [] })));
    f.database.sqlite.exec("UPDATE calendar_events SET next_reminder_at=NULL");
    // Stamped after the tick that created it (the Workers clock moves across D1 I/O), so it waits for the next tick.
    f.database.sqlite.prepare("INSERT INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,next_attempt_at,created_at,updated_at,dedupe_key,sent_copy_saved) VALUES('start',?,'u','employee@example.com','reminder',?,'2030-03-09T14:00:30.000Z','2030-03-09T14:00:30.000Z','2030-03-09T14:00:30.000Z','start',2)")
      .run(made.data.id, JSON.stringify({ from: "employee@example.com", to: "employee@example.com", subject: "Reminder: Planning", text: "" }));
    vi.setSystemTime(new Date("2030-03-09T14:01:05Z"));
    await dispatchCalendar(f.env);
    expect(reminders(f).map((r) => [r.recipient, r.status])).toEqual([["employee@example.com", "sent"]]);
  });
});

describe("Restoring cancelled events (C3)", () => {
  it("re-confirms a cancelled event with fresh invitations and reset responses, revision-checked and owner-only", async () => {
    const f = fixture();
    const made = await json<CalendarEvent>(f.request("/calendar", "POST", input({ recurrence: "", attendees: ["guest@external.test", "other@example.com"] })));
    const token = JSON.parse(String(f.database.sqlite.prepare("SELECT payload FROM calendar_deliveries WHERE recipient='guest@external.test'").get()?.payload)).text.match(/respond#([a-f0-9-]{72})/)[1];
    await f.request("/rsvp", "POST", { token, response: "accepted" });
    expect((await f.request(`/calendar/${made.data.id}/restore`, "POST", { revision: 1 })).status).toBe(409); // not cancelled
    expect((await f.request(`/calendar/${made.data.id}/cancel`, "POST", { revision: 1 })).status).toBe(200);
    expect(await response(f, made.data.id, "guest@external.test")).toBe("accepted");
    const put = await f.request(`/calendar/${made.data.id}`, "PUT", { ...input({ recurrence: "" }), revision: 2 });
    expect(put.status).toBe(409);
    expect((await json(put)).error).toContain("Restore");
    expect((await f.request(`/calendar/${made.data.id}/restore`, "POST", {})).status).toBe(409);
    expect((await f.request(`/calendar/${made.data.id}/restore`, "POST", { revision: 1 })).status).toBe(409);
    const restored = await f.request(`/calendar/${made.data.id}/restore`, "POST", { revision: 2 });
    expect(restored.status).toBe(200);
    const event = (await getEvent(f.env, made.data.id))!;
    expect(event).toMatchObject({ status: "confirmed", revision: 3 });
    expect(event.responses.map((r) => r.response)).toEqual(["needs-action", "needs-action"]);
    const invitations = f.database.sqlite.prepare("SELECT recipient,kind,status,payload FROM calendar_deliveries WHERE dedupe_key LIKE ? ORDER BY recipient").all(`${made.data.id}:3:%`);
    expect(invitations.map((j) => [j.recipient, j.kind, j.status])).toEqual([["guest@external.test", "invitation", "queued"], ["other@example.com", "invitation", "queued"]]);
    expect(JSON.parse(String(invitations[0].payload)).attachments[0].type).toContain("method=REQUEST");
    expect((await f.request(`/calendar/${made.data.id}/restore`, "POST", { revision: 3 })).status).toBe(409);
    f.database.sqlite.exec("INSERT INTO users(id,email,display_name,password_hash,role) VALUES('other','other@example.com','Other','h','employee')");
    const theirs = await saveEvent(f.env, "other", "other@example.com", input({ attendees: [] }), null);
    await saveEvent(f.env, "other", "other@example.com", theirs, theirs, 1, "cancelled");
    expect((await f.request(`/calendar/${theirs.id}/restore`, "POST", { revision: 2 })).status).toBe(404);
  });
});
