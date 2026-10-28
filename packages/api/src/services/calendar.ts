import { mailboxEnv, centralDB } from './mailbox-storage';
import { assertMeetingAllowed } from './meeting-policy';
import { meetingText } from '@email-service/shared';
import {
  calendarFile,
  occurrences,
  parseCalendarReply,
  seriesSlots,
  type CalendarEvent,
  type CalendarInput,
  type Attendance,
} from "@email-service/shared/productivity";
import type { Env, SendEmailMessage } from "../types";
import {
  generateUUIDv7,
  nowIso,
  emailBodyKey,
  emailBodyTextKey,
  attachmentKey,
} from "../lib/utils";

export interface EventRow {
  id: string;
  owner_id: string;
  uid: string;
  organizer: string;
  title: string;
  description: string;
  location: string;
  meeting_json: string;
  start_at: string;
  end_at: string;
  timezone: string;
  all_day: number;
  recurrence: string;
  excluded_dates: string;
  reminder_minutes: number | null;
  revision: number;
  status: "confirmed" | "cancelled";
}
export const eventMap = (r: EventRow): CalendarEvent => ({
  id: r.id,
  ownerId: r.owner_id,
  uid: r.uid,
  organizer: r.organizer,
  title: r.title,
  description: r.description,
  location: r.location,
  meeting: JSON.parse(r.meeting_json || "null"),
  start: r.start_at,
  end: r.end_at,
  timezone: r.timezone,
  allDay: !!r.all_day,
  recurrence: r.recurrence,
  excludedDates: JSON.parse(r.excluded_dates),
  reminderMinutes: r.reminder_minutes,
  revision: r.revision,
  status: r.status,
  attendees: [],
  responses: [],
});
export async function getEvent(
  env: Env,
  id: string,
): Promise<CalendarEvent | null> {
  const r = await env.DB.prepare("SELECT * FROM calendar_events WHERE id=?")
    .bind(id)
    .first<EventRow>();
  if (!r) return null;
  const people = await env.DB.prepare(
    "SELECT email,response FROM calendar_attendees WHERE event_id=? ORDER BY email",
  )
    .bind(id)
    .all<{ email: string; response: Attendance }>();
  return {
    ...eventMap(r),
    attendees: people.results.map((p) => p.email),
    responses: people.results,
  };
}
export async function tokenHash(token: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function nextReminder(
  event: CalendarEvent,
  after = Date.now(),
): string | null {
  if (event.reminderMinutes === null || event.status === "cancelled")
    return null;
  const next = occurrences(
    event,
    new Date(after).toISOString(),
    '2102-01-01T00:00:00.000Z',
  ).find(
    (e) =>
      +new Date(e.occurrenceStart!) - event.reminderMinutes! * 60000 > after,
  );
  return next
    ? new Date(
        +new Date(next.occurrenceStart!) - event.reminderMinutes * 60000,
      ).toISOString()
    : null;
}
function jobStatement(
  env: Env,
  event: CalendarEvent,
  recipient: string,
  kind: string,
  payload: SendEmailMessage,
  key: string,
  mutation?: string,
  userId = event.ownerId,
) {
  const now = nowIso();
  return env.DB.prepare(
    `INSERT OR IGNORE INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,next_attempt_at,created_at,updated_at,dedupe_key,sent_copy_saved)
 SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM calendar_events WHERE id=? AND revision=? AND (? IS NULL OR mutation_id=?))`,
  ).bind(
    generateUUIDv7(),
    event.id,
    userId,
    recipient,
    kind,
    JSON.stringify(payload),
    now,
    now,
    now,
    key,
    // 2 = no Sent copy needed: a reminder is a note to oneself. Non-zero, so the 30-day purge still removes it.
    kind === "reminder" ? 2 : 0,
    event.id,
    event.revision,
    mutation || null,
    mutation || null,
  );
}
function message(
  event: CalendarEvent,
  to: string,
  method: string,
  url: string,
  content = calendarFile([event], method),
): SendEmailMessage {
  return {
    from: event.organizer,
    to,
    subject: `${method === "CANCEL" ? "Cancelled: " : event.revision > 1 ? "Updated invitation: " : "Invitation: "}${event.title}`,
    text: `${event.title}\n${event.allDay ? event.start.slice(0, 10) : new Date(event.start).toLocaleString("en-GB", { timeZone: event.timezone })} (${event.timezone})\n${event.location}\n${meetingText(event.meeting)}\n\n${event.description}\n\n${method === "CANCEL" ? "This event has been cancelled." : `Respond to this invitation: ${url}\nThis private link identifies your invitation. Do not forward it.`}`,
    attachments: [
      {
        filename: "invitation.ics",
        type: `text/calendar; charset=utf-8; method=${method}`,
        content,
        disposition: "attachment",
      },
    ],
  };
}
export const calendarLimitMessage = "Calendar limit is 5,000 events. Export and remove old events first.";
/** The only saveEvent failures routes report as 409; anything else is an unexpected 500. */
export class CalendarConflict extends Error {}
/** The calendar_event_limit trigger aborts the INSERT, which D1 reports as a raw SQL error. */
export const isCalendarLimit = (e: unknown) => /Calendar limit is 5000 events/.test(String((e as Error)?.message));
/** Mutation token makes every dependent write conditional on the same successful compare-and-swap. */
export async function saveEvent(
  env: Env,
  userId: string,
  email: string,
  input: CalendarInput,
  previous: CalendarEvent | null,
  revision?: number,
  status: "confirmed" | "cancelled" = "confirmed",
  excludedDates?: string[],
  stagedStatements?: D1PreparedStatement[],
): Promise<CalendarEvent> {
  await assertMeetingAllowed(env, input.meeting, previous?.meeting);
  const now = nowIso(),
    mutation = crypto.randomUUID(),
    id = previous?.id || generateUUIDv7();
  const event: CalendarEvent = {
    ...input,
    id,
    ownerId: userId,
    organizer: email,
    uid: previous?.uid || `${id}@${env.EMAIL_DOMAIN}`,
    revision: (previous?.revision || 0) + 1,
    status,
    responses: [],
    excludedDates:
      excludedDates || input.excludedDates || previous?.excludedDates || [],
  };
  event.attendees = event.attendees.filter((a) => a !== email.toLowerCase());
  // Only a schedule change or a restore asks attendees to respond again; other edits keep their responses.
  const reset = !previous || previous.status === "cancelled" || (["start", "end", "timezone", "allDay", "recurrence"] as const).some((k) => previous[k] !== event[k]);
  if (previous && !reset) event.responses = previous.responses.filter((r) => event.attendees.includes(r.email));
  else if (previous) {
    // Exclusions are exact instants: move each to the same rule date in the new series, dropping any past its end or in a DST gap.
    const series = (e: CalendarEvent) => e.recurrence ? seriesSlots(e, e.start, "2102-01-01T00:00:00.000Z").map((d) => d?.toISOString() ?? null) : [];
    const before = series(previous), after = series(event);
    event.excludedDates = event.excludedDates.flatMap((d) => { const i = before.indexOf(d), moved = after[i]; return i < 0 ? [d] : moved ? [moved] : []; });
  }
  const statements: D1PreparedStatement[] = [];
  const values = [
    event.title,
    event.description,
    event.location,
    JSON.stringify(event.meeting || null),
    event.start,
    event.end,
    occurrences({...event,status:'confirmed',excludedDates:[]},event.start,'2102-01-01T00:00:00.000Z').at(-1)?.occurrenceEnd || event.end,
    event.timezone,
    Number(event.allDay),
    event.recurrence,
    JSON.stringify(event.excludedDates),
    event.reminderMinutes,
    nextReminder(event),
    event.revision,
    event.status,
    now,
    mutation,
  ];
  if (previous) {
    statements.push(
      env.DB.prepare(
        `UPDATE calendar_events SET title=?,description=?,location=?,meeting_json=?,start_at=?,end_at=?,series_end_at=?,timezone=?,all_day=?,recurrence=?,excluded_dates=?,reminder_minutes=?,next_reminder_at=?,revision=?,status=?,updated_at=?,mutation_id=? WHERE id=? AND owner_id=? AND revision=?`,
      ).bind(...values, id, userId, revision ?? -1),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO calendar_events(title,description,location,meeting_json,start_at,end_at,series_end_at,timezone,all_day,recurrence,excluded_dates,reminder_minutes,next_reminder_at,revision,status,updated_at,mutation_id,id,owner_id,uid,organizer,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(...values, id, userId, event.uid, email, now),
    );
  }
  const guard =
    "EXISTS(SELECT 1 FROM calendar_events WHERE id=? AND mutation_id=?)";
  statements.push(
    env.DB.prepare(
      `UPDATE calendar_deliveries SET status='cancelled',payload='{}',updated_at=? WHERE event_id=? AND status IN ('queued','failed','uncertain') AND ${guard}`,
    ).bind(now, id, id, mutation),
  );
  statements.push(
    env.DB.prepare(
      `DELETE FROM calendar_attendees WHERE event_id=? AND email NOT IN (SELECT value FROM json_each(?)) AND ${guard}`,
    ).bind(id, JSON.stringify(event.attendees), id, mutation),
  );
  const invitationFile = event.attendees.length ? calendarFile([event], status === "cancelled" ? "CANCEL" : "REQUEST") : '';
  for (const recipient of event.attendees) {
    const token = crypto.randomUUID() + crypto.randomUUID(),
      hash = await tokenHash(token);
    statements.push(
      env.DB.prepare(
        // Links always rotate (only hashes are stored); the response survives unless the schedule changed.
        `INSERT INTO calendar_attendees(event_id,email,token_hash) SELECT ?,?,? WHERE ${guard} ON CONFLICT(event_id,email) DO UPDATE SET token_hash=excluded.token_hash,response=CASE WHEN ?=1 THEN 'needs-action' ELSE response END`,
      ).bind(id, recipient, hash, id, mutation, Number(reset)),
    );
    statements.push(
      jobStatement(
        env,
        event,
        recipient,
        status === "cancelled" ? "cancellation" : "invitation",
        message(
          event,
          recipient,
          status === "cancelled" ? "CANCEL" : "REQUEST",
          `${env.APP_URL}/calendar/respond#${token}`,
          invitationFile,
        ),
        `${id}:${event.revision}:${recipient}`,
        mutation,
      ),
    );
  }
  for (const removed of (previous?.attendees || []).filter(
    (a) => !event.attendees.includes(a),
  )) {
    const cancelled = {
      ...event,
      status: "cancelled" as const,
      attendees: [removed],
    };
    statements.push(
      jobStatement(
        env,
        event,
        removed,
        "cancellation",
        message(cancelled, removed, "CANCEL", ""),
        `${id}:${event.revision}:${removed}:removed`,
        mutation,
      ),
    );
  }
  if (stagedStatements) { stagedStatements.push(...statements); return event; }
  const result = await env.DB.batch(statements).catch((e) => { throw isCalendarLimit(e) ? new CalendarConflict(calendarLimitMessage) : e; });
  if (!result[0].meta.changes)
    throw new CalendarConflict(
      previous
        ? "Event changed or was removed. Reload and try again."
        : calendarLimitMessage,
    );
  return event;
}
export async function respond(
  env: Env,
  event: CalendarEvent,
  email: string,
  response: Attendance,
  notify = true,
): Promise<void> {
  if (event.status === "cancelled")
    throw new Error("This event has been cancelled");
  if (!["accepted", "tentative", "declined"].includes(response))
    throw new Error("Choose a valid response");
  const now = nowIso(), id = generateUUIDv7();
  const payload: SendEmailMessage = { from: event.organizer, to: event.organizer,
    subject: `${response}: ${event.title}`, text: `${email} ${response} your invitation to ${event.title}.\nOpen your calendar: ${env.APP_URL}/mail/calendar` };
  const results = await env.DB.batch([
    ...notify ? [env.DB.prepare(`INSERT INTO calendar_deliveries(id,event_id,user_id,recipient,kind,payload,next_attempt_at,created_at,updated_at,dedupe_key)
      SELECT ?,?,?,?,'response',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM calendar_attendees a JOIN calendar_events e ON e.id=a.event_id WHERE a.event_id=? AND a.email=? AND a.response<>? AND e.revision=? AND e.status='confirmed')`)
      .bind(id,event.id,event.ownerId,event.organizer,JSON.stringify(payload),now,now,now,`${event.id}:response:${id}`,event.id,email,response,event.revision)] : [],
    env.DB.prepare(`UPDATE calendar_attendees SET response=? WHERE event_id=? AND email=? AND response<>? AND EXISTS(SELECT 1 FROM calendar_events WHERE id=? AND revision=? AND status='confirmed')`)
      .bind(response,event.id,email,response,event.id,event.revision),
  ]);
  if (!results.at(-1)!.meta.changes) {
    const same = await env.DB.prepare(`SELECT 1 AS ok FROM calendar_attendees a JOIN calendar_events e ON e.id=a.event_id WHERE a.event_id=? AND a.email=? AND a.response=? AND e.revision=? AND e.status='confirmed'`).bind(event.id,email,response,event.revision).first();
    if (!same) throw new Error('The invitation changed. Open the latest invitation and try again.');
  }
}
/** An emailed iTIP REPLY updates a response only on the recipient's own confirmed event, for a listed attendee
 * whose ENVELOPE sender is that attendee. That check is the only gate, like the bearer RSVP link. Per-occurrence
 * replies are ignored. No response email is queued: the organizer already has the reply mail. */
export async function applyEmailedReply(env: Env, userId: string, envelopeFrom: string, ics: string): Promise<void> {
  if (!/^METHOD:REPLY\s*$/im.test(ics)) return; // invitations and cancellations are not replies, and not errors
  const reply = parseCalendarReply(ics), response = reply.partstat as Attendance, suffix = `@${env.EMAIL_DOMAIN}`;
  if (reply.recurrenceId || !["accepted", "tentative", "declined"].includes(response) || reply.attendee !== envelopeFrom.toLowerCase() || !reply.uid.endsWith(suffix)) return;
  const central = { ...env, DB: centralDB(env) };
  const event = await getEvent(central, reply.uid.slice(0, -suffix.length));
  if (!event || event.ownerId !== userId || event.uid !== reply.uid || event.status !== "confirmed" || !event.attendees.includes(reply.attendee)) return;
  await respond(central, event, reply.attendee, response, false);
}
export async function dispatchCalendar(env: Env): Promise<void> {
  const now = nowIso();
  await env.DB.prepare(
    "UPDATE calendar_deliveries SET status='uncertain',error='Delivery could not be confirmed. Check before retrying.',updated_at=? WHERE status='sending' AND updated_at<?",
  )
    .bind(now, new Date(Date.now() - 20 * 60000).toISOString())
    .run();
  const reminders = await env.DB.prepare(
    "SELECT * FROM calendar_events WHERE status='confirmed' AND next_reminder_at<=? ORDER BY next_reminder_at LIMIT 50",
  )
    .bind(now)
    .all<EventRow & { next_reminder_at: string }>();
  // Internal attendees who have not declined get their own reminder, from and to their own address
  // under their own user_id, so the from-address check below holds for it.
  const internal = reminders.results.length ? (await env.DB.prepare(
    "SELECT a.event_id,u.id,u.email FROM calendar_attendees a JOIN users u ON u.email=a.email WHERE a.event_id IN (SELECT value FROM json_each(?)) AND a.response<>'declined' AND COALESCE(u.must_reset_password,0)=0",
  ).bind(JSON.stringify(reminders.results.map((r) => r.id))).all<{ event_id: string; id: string; email: string }>()).results : [];
  for (const r of reminders.results) {
    const event = eventMap(r),
      due = r.next_reminder_at;
    const statements: D1PreparedStatement[] = [];
    // Skip reminders more than a day late following an outage, or whose occurrence started over a minute ago.
    if (+new Date(due) > Date.now() - Math.min(86400000, event.reminderMinutes! * 60000 + 60000))
      for (const person of [{ id: event.ownerId, email: event.organizer }, ...internal.filter((p) => p.event_id === event.id)])
        statements.push(
          jobStatement(
            env,
            event,
            person.email,
            "reminder",
            {
              from: person.email,
              to: person.email,
              subject: `Reminder: ${event.title}`,
              text: `${event.title}\n${event.location}\n${meetingText(event.meeting)}\nOpen your calendar: ${env.APP_URL}/mail/calendar`,
            },
            `${event.id}:reminder:${event.revision}:${due}:${person.email}`,
            undefined,
            person.id,
          ),
        );
    statements.push(
      env.DB.prepare(
        "UPDATE calendar_events SET next_reminder_at=? WHERE id=? AND revision=? AND next_reminder_at=?",
      ).bind(nextReminder(event), event.id, event.revision, due),
    );
    await env.DB.batch(statements);
  }
  // A reminder still queued once its occurrence has started is useless. created_at is at or after the due time.
  // +2 minutes: a reminder is stamped after this tick's `now`, so it is first picked up by the next
  // once-a-minute tick; without the grace an "At start" (0-minute) reminder was cancelled, never sent.
  await env.DB.prepare(
    "UPDATE calendar_deliveries SET status='cancelled',payload='{}',updated_at=? WHERE kind='reminder' AND status='queued' AND EXISTS(SELECT 1 FROM calendar_events e WHERE e.id=calendar_deliveries.event_id AND julianday(calendar_deliveries.created_at)+(COALESCE(e.reminder_minutes,0)+2)/1440.0<julianday(?))",
  )
    .bind(now, now)
    .run();
  // Reminders first: they are useless late, invitations are not.
  const jobs = await env.DB.prepare(
    "SELECT id FROM calendar_deliveries WHERE status='queued' AND next_attempt_at<=? ORDER BY kind<>'reminder',next_attempt_at LIMIT 30",
  )
    .bind(now)
    .all<{ id: string }>();
  for (const { id } of jobs.results) {
    const job = await env.DB.prepare(
      "UPDATE calendar_deliveries SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued' AND next_attempt_at<=? RETURNING payload,attempts,user_id",
    )
      .bind(nowIso(), id, nowIso())
      .first<{ payload: string; attempts: number; user_id: string }>();
    if (!job) continue;
    const user = await env.DB.prepare(
      "SELECT must_reset_password,email FROM users WHERE id=?",
    )
      .bind(job.user_id)
      .first<{ must_reset_password: number; email:string }>();
    if (!user || user.must_reset_password || user.email.toLowerCase() !== String(JSON.parse(job.payload).from).toLowerCase()) {
      await env.DB.prepare(
        "UPDATE calendar_deliveries SET status='failed',error='Sending account is unavailable or requires a password reset' WHERE id=?",
      )
        .bind(id)
        .run();
      continue;
    }
    try {
      const payload = JSON.parse(job.payload) as SendEmailMessage;
      // D1 stores calendar text as JSON. Materialize UTF-8 bytes only at the
      // binding boundary, including older queued jobs, to avoid string/base64
      // ambiguity and preserve readable calendar text in the Sent copy.
      const outgoing: SendEmailMessage = {
        ...payload,
        ...(payload.attachments?.length ? {
          attachments: payload.attachments.map((attachment) => ({
            ...attachment,
            disposition: attachment.disposition || "attachment",
            content: typeof attachment.content === "string"
              ? new TextEncoder().encode(attachment.content)
              : attachment.content,
          })),
        } : {}),
      };
      await env.SEND_EMAIL.send(outgoing);
    } catch (e) {
      const code = String((e as { code?: string })?.code || "");
      // Keep diagnostics useful without logging invitation bodies or RSVP tokens.
      console.error("Calendar delivery rejected", { deliveryId: id, code: /^E_[A-Z_]+$/.test(code) ? code : "UNKNOWN" });
      const reasons: Record<string, string> = {
        E_SENDER_NOT_VERIFIED: "The organizer's email domain is not verified for sending. Contact your administrator.",
        E_SENDER_DOMAIN_NOT_AVAILABLE: "The organizer's email domain is not enabled for sending. Contact your administrator.",
        E_VALIDATION_ERROR: "The email provider rejected the invitation format. Contact your administrator.",
        E_FIELD_MISSING: "The invitation is missing a required email field. Contact your administrator.",
        E_RECIPIENT_NOT_ALLOWED: "Sending to this recipient is not allowed by the email configuration.",
        E_RECIPIENT_SUPPRESSED: "Delivery to this recipient is suppressed by the email provider.",
        E_CONTENT_TOO_LARGE: "The invitation exceeds the email provider's size limit.",
        E_DELIVERY_FAILED: "The recipient's mail server rejected delivery. Check the recipient address.",
      };
      const retry =
        [
          "E_RATE_LIMIT_EXCEEDED",
          "E_DAILY_LIMIT_EXCEEDED",
          "E_INTERNAL_SERVER_ERROR",
        ].includes(code) && job.attempts < 12;
      const state = retry
        ? "queued"
        : ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS", "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE", "E_DELIVERY_FAILED", "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG", "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY"].includes(code)
          ? "failed"
          : "uncertain";
      await env.DB.prepare(
        "UPDATE calendar_deliveries SET status=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?",
      )
        .bind(
          state,
          retry
            ? "Temporary delivery problem. Will retry."
            : state === "uncertain"
              ? "Delivery could not be confirmed. Check before retrying."
              : (reasons[code] || "Provider rejected delivery. Check the recipient and sending configuration."),
          new Date(
            Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts),
          ).toISOString(),
          nowIso(),
          id,
        )
        .run();
      continue;
    }
    // A failure here leaves "sending" for recovery, never automatically sends twice.
    await env.DB.prepare(
      "UPDATE calendar_deliveries SET status='sent',error=NULL,updated_at=? WHERE id=?",
    )
      .bind(nowIso(), id)
      .run();
  }
  const copies = await env.DB.prepare(
    "SELECT id,user_id,payload,updated_at,attempts FROM calendar_deliveries WHERE status='sent' AND sent_copy_saved=0 AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 30",
  ).bind(now).all<{ id: string; user_id: string; payload: string; updated_at: string; attempts: number }>();
  for (const copy of copies.results) {
    try {
      await saveSentCopy(env, copy);
    } catch (e) {
      console.error("Calendar sent-copy persistence will retry", e);
      // Back off so failing copies cannot starve the rest, then give up (-1). attempts also counts
      // send tries (at most 12), so a copy gets 12-23 tries. updated_at stays the Sent timestamp.
      await env.DB.prepare(
        "UPDATE calendar_deliveries SET attempts=attempts+1,next_attempt_at=?,sent_copy_saved=CASE WHEN attempts>=23 THEN -1 ELSE 0 END,error=CASE WHEN attempts>=23 THEN 'Delivered, but the copy in Sent could not be saved.' ELSE error END WHERE id=? AND sent_copy_saved=0",
      )
        .bind(new Date(Date.now() + Math.min(3600000, 60000 * 2 ** copy.attempts)).toISOString(), copy.id)
        .run();
    }
  }
  await env.DB.prepare(
    "DELETE FROM calendar_deliveries WHERE (status='cancelled' OR (status='sent' AND sent_copy_saved<>0) OR (kind='reminder' AND status IN ('failed','uncertain'))) AND updated_at<?",
  )
    .bind(new Date(Date.now() - 30 * 86400000).toISOString())
    .run();
}

/** Provider delivery and Sent persistence have separate recovery paths; a storage failure never resends. */
async function saveSentCopy(
  env: Env,
  job: { id: string; user_id: string; payload: string; updated_at: string },
) {
  env = await mailboxEnv(env, job.user_id);
  const p = JSON.parse(job.payload) as SendEmailMessage;
  const folder = await env.DB.prepare(
    "SELECT id FROM folders WHERE user_id=? AND type='sent'",
  )
    .bind(job.user_id)
    .first<{ id: string }>();
  if (!folder) throw new Error("Sent folder is unavailable");
  const body = p.text || "",
    key = emailBodyKey(job.user_id, job.id),
    textKey = emailBodyTextKey(job.user_id, job.id);
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  await env.EMAIL_BUCKET.put(key, `<pre>${escaped}</pre>`, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  await env.EMAIL_BUCKET.put(textKey, body, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  const from = typeof p.from === "string" ? p.from : p.from.email,
    recipient = typeof p.to === "string" ? p.to : "";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO emails(id,thread_id,folder_id,user_id,sender,recipients_to,subject,snippet,r2_body_key,is_read,has_attachments,size,received_at,delivery_status) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,'sent')`,
    ).bind(
      job.id,
      job.id,
      folder.id,
      job.user_id,
      from,
      JSON.stringify([{ email: recipient }]),
      p.subject,
      body.slice(0, 200),
      key,
      p.attachments?.length ? 1 : 0,
      new TextEncoder().encode(body).length,
      job.updated_at,
    ),
  ];
  for (let i = 0; i < (p.attachments?.length || 0); i++) {
    const a = p.attachments![i],
      id = `${job.id}-${i}`,
      r2Key = attachmentKey(job.user_id, job.id, id, a.filename),
      content = String(a.content);
    await env.EMAIL_BUCKET.put(r2Key, content, {
      httpMetadata: { contentType: a.type || "text/calendar" },
    });
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO attachments(id,email_id,filename,mime_type,size,r2_key,created_at,disposition) VALUES(?,?,?,?,?,?,?,'attachment')`,
      ).bind(
        id,
        job.id,
        a.filename,
        a.type || "text/calendar",
        new TextEncoder().encode(content).length,
        r2Key,
        job.updated_at,
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO emails_fts(email_id,user_id,subject,sender,snippet) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM emails_fts WHERE email_id=?)",
    ).bind(job.id, job.user_id, p.subject, from, body.slice(0, 200), job.id),
  );
  await env.DB.batch(statements);
  await centralDB(env).prepare("UPDATE calendar_deliveries SET sent_copy_saved=1 WHERE id=?").bind(job.id).run();
}
