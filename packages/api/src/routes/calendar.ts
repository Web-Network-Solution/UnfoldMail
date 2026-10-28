import { enabledMeetingProviders, assertMeetingAllowed, MeetingNotAllowed } from '../services/meeting-policy';
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  validateCalendar,
  occurrences,
  calendarFile,
  parseCalendarFile,
  type Attendance,
} from "@email-service/shared/productivity";
import type { Env, HonoVariables } from "../types";
import {
  eventMap,
  getEvent,
  saveEvent,
  respond,
  tokenHash,
  isCalendarLimit,
  calendarLimitMessage,
  CalendarConflict,
  type EventRow,
} from "../services/calendar";
import { nowIso } from "../lib/utils";

type App = { Bindings: Env; Variables: HonoVariables };
const routes = new Hono<App>();
routes.use(
  "*",
  bodyLimit({
    maxSize: 1100000,
    onError: (c) =>
      c.json(
        { success: false, error: "Calendar file must be under 1 MB" },
        413,
      ),
  }),
);
routes.onError((e, c) => {
  console.error("Calendar request failed", e);
  return c.json(
    { success: false, error: "Unable to complete calendar operation" },
    500,
  );
});
/** Stale revisions and the event limit are 409; any other save failure goes to onError. */
const conflict = (c: Context<App>, e: unknown) => {
  if (e instanceof CalendarConflict) return c.json({ success: false, error: e.message }, 409);
  throw e;
};
/** A disabled meeting provider is a 400; a failed settings read goes to onError. */
const disallowed = (c: Context<App>, e: unknown) => {
  if (e instanceof MeetingNotAllowed) return c.json({ success: false, error: e.message }, 400);
  throw e;
};
// A cancelled event changes only through restore, which explicitly re-invites every attendee.
const cancelledEvent = (c: Context<App>, error = "This event has been cancelled") => c.json({ success: false, error }, 409);
routes.get("/providers", async c => c.json({success: true, data: await enabledMeetingProviders(c.env)}));
routes.get("/", async (c) => {
  const from = c.req.query("from") || "",
    to = c.req.query("to") || "";
  if (
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 93 * 86400000
  )
    return c.json(
      { success: false, error: "Request a valid range of up to 93 days" },
      400,
    );
  const includeCancelled = c.req.query('cancelled') === 'true' ? 1 : 0;
  const dateFilter = "(e.status='confirmed' OR ?=1) AND e.start_at<? AND e.series_end_at>?";
  const rows = await c.env.DB.prepare(
    `SELECT e.* FROM calendar_events e WHERE e.owner_id=? AND ${dateFilter}
     UNION ALL SELECT e.* FROM calendar_attendees a JOIN calendar_events e ON e.id=a.event_id WHERE a.email=? AND e.owner_id<>? AND ${dateFilter}
     ORDER BY start_at LIMIT 5001`
  ).bind(c.get('userId'),includeCancelled,new Date(to).toISOString(),new Date(from).toISOString(),c.get('userEmail'),c.get('userId'),includeCancelled,new Date(to).toISOString(),new Date(from).toISOString()).all<EventRow>();
  if (rows.results.length > 5000)
    return c.json(
      { success: false, error: "Too many events in this range" },
      400,
    );
  const events: import('@email-service/shared').CalendarEvent[] = [];
  for (const row of rows.results) {
    for (const event of occurrences({ ...eventMap(row), status: 'confirmed' }, from, to)) {
      events.push({ ...event, description: '', status: row.status });
      if (events.length > 3000) return c.json({ success: false, error: 'Too many occurrences. Choose a shorter calendar view.' }, 400);
    }
  }
  return c.json({
    success: true,
    data: events.sort((a, b) =>
      a.occurrenceStart!.localeCompare(b.occurrenceStart!),
    ),
  });
});
routes.get("/export", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM calendar_events WHERE owner_id=? ORDER BY start_at LIMIT 1001",
  )
    .bind(c.get("userId"))
    .all<EventRow>();
  if (rows.results.length > 1000)
    return c.json(
      {
        success: false,
        error:
          "Export supports up to 1,000 events. Export individual events instead.",
      },
      400,
    );
  let content: string;
  try { content = calendarFile(rows.results.map(eventMap)); }
  catch (error) { return c.json({success: false, error: error instanceof Error ? error.message : "Unable to export calendar"}, 400); }
  return c.body(content, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'attachment; filename="calendar.ics"',
    "Cache-Control": "no-store",
  });
});
routes.post("/import/preview", async (c) => {
  try {
    const v = await c.req.json();
    return c.json({
      success: true,
      data: parseCalendarFile(v.content, v.timezone || "UTC"),
    });
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid calendar",
      },
      400,
    );
  }
});
routes.post("/import", async (c) => {
  // Validate the entire file before any writes. Imports never send invitations.
  let inputs;
  try {
    const v = await c.req.json();
    inputs = parseCalendarFile(v.content, v.timezone || "UTC");
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid calendar",
      },
      400,
    );
  }
  try { for (const input of inputs) await assertMeetingAllowed(c.env, input.meeting); }
  catch (e) { return disallowed(c, e); }
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM calendar_events WHERE owner_id=?",
  )
    .bind(c.get("userId"))
    .first<{ n: number }>();
  if ((count?.n || 0) + inputs.length > 5000)
    return c.json({ success: false, error: calendarLimitMessage }, 409);
  const statements: D1PreparedStatement[] = [];
  for (const input of inputs) await saveEvent(c.env,c.get('userId'),c.get('userEmail'),input,null,undefined,'confirmed',undefined,statements);
  try { await c.env.DB.batch(statements); }
  catch (e) { if (!isCalendarLimit(e)) throw e; return c.json({ success: false, error: calendarLimitMessage }, 409); }
  return c.json({ success: true, data: { imported: inputs.length } });
});
routes.post("/", async (c) => {
  let input;
  try {
    input = validateCalendar(await c.req.json());
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid event",
      },
      400,
    );
  }
  try { await assertMeetingAllowed(c.env, input.meeting); }
  catch (e) { return disallowed(c, e); }
  try {
    return c.json(
      {
        success: true,
        data: await saveEvent(
          c.env,
          c.get("userId"),
          c.get("userEmail"),
          input,
          null,
        ),
      },
      201,
    );
  } catch (e) {
    return conflict(c, e);
  }
});
routes.get("/:id", async (c) => {
  const e = await getEvent(c.env, c.req.param("id"));
  if (
    !e ||
    (e.ownerId !== c.get("userId") &&
      !e.attendees.includes(c.get("userEmail").toLowerCase()))
  )
    return c.json({ success: false, error: "Event not found" }, 404);
  return c.json({ success: true, data: e });
});
routes.get("/:id/export", async (c) => {
  const e = await getEvent(c.env, c.req.param("id"));
  if (
    !e ||
    (e.ownerId !== c.get("userId") &&
      !e.attendees.includes(c.get("userEmail").toLowerCase()))
  )
    return c.json({ success: false, error: "Event not found" }, 404);
  return c.body(calendarFile([e]), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'attachment; filename="event.ics"',
    "Cache-Control": "no-store",
  });
});
routes.put("/:id", async (c) => {
  const previous = await getEvent(c.env, c.req.param("id"));
  if (!previous || previous.ownerId !== c.get("userId"))
    return c.json({ success: false, error: "Event not found" }, 404);
  if (previous.status === "cancelled") return cancelledEvent(c, "This event has been cancelled. Restore it before editing.");
  let input, raw;
  try {
    raw = await c.req.json();
    input = validateCalendar(raw);
    if (!Number.isInteger(raw.revision))
      throw new Error("Event revision is required");
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid event",
      },
      400,
    );
  }
  try { await assertMeetingAllowed(c.env, input.meeting, previous.meeting); }
  catch (e) { return disallowed(c, e); }
  try {
    return c.json({
      success: true,
      data: await saveEvent(
        c.env,
        c.get("userId"),
        c.get("userEmail"),
        input,
        previous,
        raw.revision,
      ),
    });
  } catch (e) {
    return conflict(c, e);
  }
});
routes.post("/:id/cancel", async (c) => {
  const previous = await getEvent(c.env, c.req.param("id"));
  if (!previous || previous.ownerId !== c.get("userId"))
    return c.json({ success: false, error: "Event not found" }, 404);
  if (previous.status === "cancelled") return cancelledEvent(c);
  const raw = await c.req.json().catch(() => ({}));
  let excluded = previous.excludedDates;
  if (raw.occurrence) {
    if (
      !previous.recurrence ||
      !Number.isFinite(Date.parse(raw.occurrence)) ||
      !occurrences(
        previous,
        raw.occurrence,
        new Date(Date.parse(raw.occurrence) + 1).toISOString(),
      ).some((e) => e.occurrenceStart === raw.occurrence)
    )
      return c.json({ success: false, error: "Occurrence not found" }, 400);
    excluded = [...excluded, raw.occurrence];
  }
  try {
    return c.json({
      success: true,
      data: await saveEvent(
        c.env,
        c.get("userId"),
        c.get("userEmail"),
        previous,
        previous,
        raw.revision,
        raw.occurrence ? "confirmed" : "cancelled",
        excluded,
      ),
    });
  } catch (e) {
    return conflict(c, e);
  }
});
/** Confirms a cancelled event again; every response resets and every attendee gets a fresh invitation. */
routes.post("/:id/restore", async (c) => {
  const previous = await getEvent(c.env, c.req.param("id"));
  if (!previous || previous.ownerId !== c.get("userId"))
    return c.json({ success: false, error: "Event not found" }, 404);
  if (previous.status !== "cancelled") return c.json({ success: false, error: "Only a cancelled event can be restored" }, 409);
  const raw = await c.req.json().catch(() => ({}));
  try {
    return c.json({ success: true, data: await saveEvent(c.env, c.get("userId"), c.get("userEmail"), previous, previous, raw.revision) });
  } catch (e) {
    return conflict(c, e);
  }
});
routes.delete("/:id", async (c) => {
  const e = await getEvent(c.env, c.req.param("id"));
  if (!e || e.ownerId !== c.get("userId"))
    return c.json({ success: false, error: "Event not found" }, 404);
  if (e.attendees.length)
    return c.json(
      {
        success: false,
        error: "Use Cancel event so attendees receive the cancellation",
      },
      400,
    );
  await c.env.DB.prepare(
    "DELETE FROM calendar_events WHERE id=? AND owner_id=?",
  )
    .bind(e.id, c.get("userId"))
    .run();
  return c.json({ success: true });
});
routes.post("/:id/respond", async (c) => {
  const e = await getEvent(c.env, c.req.param("id"));
  if (!e || !e.attendees.includes(c.get("userEmail").toLowerCase()))
    return c.json({ success: false, error: "Invitation not found" }, 404);
  try {
    await respond(c.env, e, c.get("userEmail"), (await c.req.json()).response);
    return c.json({ success: true });
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid response",
      },
      400,
    );
  }
});
routes.get("/:id/deliveries", async (c) => {
  const e = await getEvent(c.env, c.req.param("id"));
  if (!e || e.ownerId !== c.get("userId"))
    return c.json({ success: false, error: "Event not found" }, 404);
  const rows = await c.env.DB.prepare(
    // Attendees' reminders are theirs: the organizer can neither see nor retry them.
    "SELECT id,recipient,kind,status,error,created_at FROM calendar_deliveries WHERE event_id=? AND (kind<>'reminder' OR user_id=?) ORDER BY created_at DESC LIMIT 100",
  )
    .bind(e.id, c.get("userId"))
    .all();
  return c.json({ success: true, data: rows.results });
});
routes.post("/:id/deliveries/:job/retry", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const result = await c.env.DB.prepare(
    `UPDATE calendar_deliveries SET status='queued',attempts=0,next_attempt_at=?,updated_at=?,error=NULL WHERE id=? AND event_id=? AND user_id=? AND (status='failed' OR (status='uncertain' AND ?=1))`,
  )
    .bind(
      nowIso(),
      nowIso(),
      c.req.param("job"),
      c.req.param("id"),
      c.get("userId"),
      raw.acknowledgeDuplicate === true ? 1 : 0,
    )
    .run();
  if (!result.meta.changes)
    return c.json(
      {
        success: false,
        error:
          "Cannot retry this delivery. Unconfirmed delivery requires duplicate-risk acknowledgement.",
      },
      409,
    );
  return c.json({ success: true });
});

// Tokens are submitted in JSON; private response links use fragments, not logged query strings.
const publicRoutes = new Hono<App>();
publicRoutes.use("*", bodyLimit({ maxSize: 4096 }));
publicRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
publicRoutes.post("/", async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  if (typeof raw.token !== "string" || raw.token.length !== 72)
    return c.json(
      { success: false, error: "Invitation link is invalid or expired" },
      404,
    );
  const a = await c.env.DB.prepare(
    "SELECT event_id,email,response FROM calendar_attendees WHERE token_hash=?",
  )
    .bind(await tokenHash(raw.token))
    .first<{ event_id: string; email: string; response: Attendance }>();
  const e = a ? await getEvent(c.env, a.event_id) : null;
  const last = e?.recurrence ? occurrences({ ...e, status: 'confirmed', excludedDates: [] },e.start,'2102-01-01T00:00:00.000Z').at(-1)?.occurrenceEnd : e?.end;
  if (!a || !e || !last || Date.parse(last) + 30 * 86400000 < Date.now())
    return c.json(
      { success: false, error: "Invitation link is invalid or expired" },
      404,
    );
  if (raw.response) {
    try {
      await respond(c.env, e, a.email, raw.response);
    } catch (err) {
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : "Invalid response",
        },
        400,
      );
    }
  }
  return c.json({
    success: true,
    data: {
      title: e.title,
      description: e.description,
      location: e.location,
      meeting: e.meeting,
      start: e.start,
      end: e.end,
      timezone: e.timezone,
      allDay: e.allDay,
      recurrence: e.recurrence,
      organizer: e.organizer,
      status: e.status,
      email: a.email,
      response: raw.response || a.response,
    },
  });
});
export { routes as calendarRoutes, publicRoutes as calendarRsvpRoutes };
