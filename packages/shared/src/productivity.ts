import { validateMeeting, meetingText } from './meetings';
export type * from "./types/productivity";
import ICAL from "ical.js";
import { RRule } from "rrule";
import { Temporal } from "@js-temporal/polyfill";
import type {
  CalendarInput,
  CalendarEvent,
  ContactInput,
} from "./types/productivity";

export function validAddress(value: string): boolean {
  return (
    value.length <= 254 &&
    /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}$/i.test(
      value,
    )
  );
}
function text(v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    v.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
  )
    throw new Error("Invalid or oversized text field");
  return v.trim();
}
export function validateContact(raw: unknown): ContactInput {
  const v = raw as ContactInput;
  if (!v || typeof v !== "object") throw new Error("Contact is required");
  const email = text(v.email, 254).toLowerCase(),
    name = text(v.name, 160);
  if (!name || !validAddress(email))
    throw new Error("Enter a name and valid email address");
  if (!Array.isArray(v.groups) || v.groups.length > 20)
    throw new Error("At most 20 groups per contact");
  return {
    name,
    email,
    phone: text(v.phone, 80),
    company: text(v.company, 160),
    notes: text(v.notes, 4000),
    groups: [...new Set(v.groups.map((g) => text(g, 60)).filter(Boolean))],
  };
}
export function wallTime(iso: string, zone: string): string {
  return Temporal.Instant.from(iso)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}
/** Nonexistent (DST gap) times always throw; repeated fall-back times throw or resolve to the earlier instant. */
export function instantFromWall(wall: string, zone: string, ambiguous: "reject" | "earlier" = "reject"): string {
  const local = Temporal.PlainDateTime.from(wall),
    zoned = local.toZonedDateTime(zone, { disambiguation: ambiguous });
  // 'earlier' shifts a gap time instead of rejecting it.
  if (!zoned.toPlainDateTime().equals(local)) throw new RangeError(`${wall} does not exist in ${zone}`);
  return zoned.toInstant().toString();
}
export function validateCalendar(raw: unknown): CalendarInput {
  const v = raw as CalendarInput;
  if (!v || typeof v !== "object") throw new Error("Event is required");
  const title = text(v.title, 200),
    description = text(v.description, 8000),
    location = text(v.location, 500),
    timezone = text(v.timezone, 100);
  if (!title) throw new Error("Event title is required");
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  if (typeof v.allDay !== "boolean") throw new Error("Invalid all-day setting");
  const start = new Date(v.start).toISOString(),
    end = new Date(v.end).toISOString();
  if (
    start < "2000" ||
    start > "2100" ||
    end <= start ||
    +new Date(end) - +new Date(start) > 366 * 86400000
  )
    throw new Error("Choose a valid start and end (maximum duration one year)");
  if (
    v.allDay &&
    (!start.endsWith("T00:00:00.000Z") || !end.endsWith("T00:00:00.000Z"))
  )
    throw new Error("All-day events must use whole dates");
  if (!Array.isArray(v.attendees) || v.attendees.length > 50)
    throw new Error("At most 50 attendees per event");
  const attendees = [
    ...new Set(v.attendees.map((a) => text(a, 254).toLowerCase())),
  ];
  if (attendees.some((a) => !validAddress(a)))
    throw new Error("An attendee email address is invalid");
  if (
    v.reminderMinutes !== null &&
    (!Number.isInteger(v.reminderMinutes) ||
      v.reminderMinutes < 0 ||
      v.reminderMinutes > 10080)
  )
    throw new Error("Reminder must be within seven days");
  const recurrence = text(v.recurrence, 300).toUpperCase();
  if (recurrence) {
    if (
      !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;(INTERVAL|COUNT|UNTIL|BYDAY|BYMONTHDAY|BYMONTH|WKST)=[A-Z0-9,+-]+)*$/.test(
        recurrence,
      )
    )
      throw new Error("Unsupported recurrence rule");
    const options = RRule.parseString(recurrence);
    if (
      (options.interval || 1) < 1 ||
      (options.interval || 1) > 365 ||
      (options.count != null && (options.count < 1 || options.count > 1000))
    )
      throw new Error("Recurrence must have 1–1,000 occurrences");
    if (!options.count && !options.until)
      throw new Error("Repeating events need an end date or occurrence count");
    if (
      options.until &&
      (+options.until < +new Date(start) ||
        +options.until - +new Date(start) > 5 * 366 * 86400000)
    )
      throw new Error("Repeat end must be within five years");
    const bounded = new RRule({ ...options, dtstart: new Date(start) }).all((_date, index) => index < 2001);
    if (bounded.length > 2000 || bounded.some(d => d.getUTCFullYear() >= 2101)) throw new Error('Recurring events must end by 2100 and contain at most 2,000 dates');
  }
  // Omitted exclusions keep the saved ones on update; an explicit [] clears them.
  const excludedDates = v.excludedDates ?? [];
  if (
    !Array.isArray(excludedDates) ||
    excludedDates.length > 1000 ||
    excludedDates.some(
      (d) => typeof d !== "string" || !Number.isFinite(Date.parse(d)),
    )
  )
    throw new Error("Invalid excluded dates");
  return {
    title,
    description,
    location,
    meeting: validateMeeting(v.meeting),
    timezone,
    allDay: v.allDay,
    start,
    end,
    recurrence,
    attendees,
    reminderMinutes: v.reminderMinutes,
    excludedDates: v.excludedDates == null ? undefined : excludedDates.map((d) => new Date(d).toISOString()),
  };
}
/** One entry per rule date near [from, to), null where the local time falls in a DST gap, so
 * two schedules of one series line up by position. Ignores status and exclusions. */
export function seriesSlots(
  event: CalendarEvent,
  from: string,
  to: string,
): (Date | null)[] {
  if (!event.recurrence) return [new Date(event.start)];
  const duration = +new Date(event.end) - +new Date(event.start);
  const start = event.allDay
    ? new Date(event.start)
    : new Date(wallTime(event.start, event.timezone) + ":00Z");
  // Generate wall-clock dates in UTC, then resolve each in the event's zone.
  // rrule's tzid conversion depends on the host timezone; Workers and desktops differ.
  const options = RRule.parseString(event.recurrence),
    until = options.until;
  const rule = new RRule({
    ...options,
    dtstart: start,
    tzid: null,
    ...(until ? { until: new Date(+until + 86400000) } : {}),
  });
  return rule
    .between(
      new Date(+new Date(from) - duration - 2 * 86400000),
      new Date(+new Date(to) + 2 * 86400000),
      true,
      (_date, index) => index < 2000,
    )
    .flatMap((d): (Date | null)[] => {
      let result: Date;
      try {
        // The first date is the saved start, even when it is the later of two repeated times.
        result = event.allDay
          ? d
          : +d === +start
            ? new Date(event.start)
            : new Date(
                instantFromWall(d.toISOString().slice(0, 19), event.timezone, "earlier"),
              );
      } catch {
        // ponytail: a gap slot within a day past UNTIL stays as a trailing null; positions still match.
        return [null];
      } // A nonexistent local time in a DST gap has no occurrence.
      return !until || +result <= +until ? [result] : [];
    });
}
export function occurrences(
  event: CalendarEvent,
  from: string,
  to: string,
): CalendarEvent[] {
  if (event.status === "cancelled") return [];
  const duration = +new Date(event.end) - +new Date(event.start);
  return seriesSlots(event, from, to)
    .filter(
      (d): d is Date =>
        !!d &&
        +d < +new Date(to) &&
        +d + duration > +new Date(from) &&
        !event.excludedDates.includes(d.toISOString()),
    )
    .map((d) => ({
      ...event,
      occurrenceStart: d.toISOString(),
      occurrenceEnd: new Date(+d + duration).toISOString(),
    }));
}

export function calendarFile(
  events: CalendarEvent[],
  method = "PUBLISH",
): string {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("prodid", "-//UnfoldMail//Calendar//EN");
  root.addPropertyWithValue("method", method);
  let exportedOccurrences = 0;
  for (const event of events) {
    if (++exportedOccurrences > 10000) throw new Error("Export exceeds 10,000 occurrences. Export individual events instead.");
    const component = new ICAL.Component("vevent");
    const add = (key: string, value: unknown) =>
      component.addPropertyWithValue(key, value);
    add("uid", event.uid);
    add("sequence", event.revision);
    add("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
    add("summary", event.title);
    add("description", event.description + (event.meeting ? "\n\n" + meetingText(event.meeting) : ""));
    if (event.meeting) { add("url",event.meeting.url); add("x-rwa-meeting-provider",event.meeting.provider); }
    add("location", event.location);
    add("status", event.status.toUpperCase());
    add("organizer", `mailto:${event.organizer}`);
    add("x-rwa-timezone", event.timezone);
    // UTC occurrences avoid depending on clients' timezone databases / VTIMEZONE support.
    // Recurring exports use RDATEs over the finite supported series, retaining exact instants.
    const time = (value: string) =>
      event.allDay
        ? ICAL.Time.fromDateString(value.slice(0, 10))
        : ICAL.Time.fromJSDate(new Date(value), true);
    add("dtstart", time(event.start));
    add("dtend", time(event.end));
    if (event.recurrence) {
      add("x-rwa-recurrence", event.recurrence);

      const all = occurrences(
        { ...event, status: "confirmed", excludedDates: [] },
        event.start,
        '2102-01-01T00:00:00.000Z',
      );
      exportedOccurrences += Math.max(0, all.length - 1);
      if (exportedOccurrences > 10000) throw new Error("Export exceeds 10,000 occurrences. Export individual events instead.");
      const values = all
        .filter((o) => o.occurrenceStart !== event.start)
        .map((o) => time(o.occurrenceStart!));
      if (values.length) {
        const p = new ICAL.Property("rdate");
        if (event.allDay) p.resetType("date");
        p.setValues(values);
        component.addProperty(p);
      }
    }
    if (event.excludedDates.length) {
      const p = new ICAL.Property("exdate");
      if (event.allDay) p.resetType("date");
      p.setValues(event.excludedDates.map(time));
      component.addProperty(p);
    }
    for (const email of event.attendees) {
      const p = new ICAL.Property("attendee");
      p.setValue(`mailto:${email}`);
      p.setParameter("rsvp", "TRUE");
      p.setParameter(
        "partstat",
        (
          event.responses.find((r) => r.email === email)?.response ||
          "needs-action"
        ).toUpperCase(),
      );
      component.addProperty(p);
    }
    root.addSubcomponent(component);
  }
  return root.toString() + "\r\n";
}

/** Explicit import produces private copies, never sends invitations or trusts an external organizer. */
export function parseCalendarFile(
  input: string,
  fallbackZone: string,
): CalendarInput[] {
  if (input.length > 1024 * 1024)
    throw new Error("Calendar import must be under 1 MB");
  const root = new ICAL.Component(ICAL.parse(input));
  if (['CANCEL', 'REPLY'].includes(String(root.getFirstPropertyValue('method')).toUpperCase())) throw new Error('This file is a cancellation or response, not a new event. Review the original invitation.');
  const events = root.getAllSubcomponents("vevent");
  if (!events.length || events.length > 100)
    throw new Error("Import between 1 and 100 events at a time");
  return events.map((c) => {
    const ownRule = c.getFirstPropertyValue("x-rwa-recurrence");
    if (c.hasProperty("recurrence-id") || (c.hasProperty("rdate") && !ownRule))
      throw new Error(
        "This file contains custom recurrence dates. Import individual events instead.",
      );
    const dt = c.getFirstPropertyValue("dtstart") as ICAL.Time,
      de = c.getFirstPropertyValue("dtend") as ICAL.Time;
    if (!dt || !de) throw new Error("Every event needs a start and end");
    const zone = String(
      c.getFirstPropertyValue("x-rwa-timezone") ||
        c.getFirstProperty("dtstart")?.getParameter("tzid") ||
        fallbackZone,
    );
    const asIso = (t: ICAL.Time) =>
      t.isDate
        ? t.toString() + "T00:00:00.000Z"
        : t.toString().endsWith("Z")
          ? new Date(t.toString()).toISOString()
          : instantFromWall(t.toString(), zone, "earlier"); // RFC 5545 3.3.5: a repeated local time means the first one.
    const excludedDates = c
      .getAllProperties("exdate")
      .flatMap((p) => p.getValues().map((t) => asIso(t as ICAL.Time)));
    const provider = c.getFirstPropertyValue('x-rwa-meeting-provider');
    const meeting = provider ? validateMeeting({provider:String(provider),url:String(c.getFirstPropertyValue('url') || '')}) : null;
    let description = String(c.getFirstPropertyValue('description') || '');
    const suffix = '\n\n'+meetingText(meeting);
    if (meeting && description.endsWith(suffix)) description = description.slice(0,-suffix.length);
    return validateCalendar({
      meeting,
      title: String(c.getFirstPropertyValue("summary") || "Untitled event"),
      description,
      location: String(c.getFirstPropertyValue("location") || ""),
      start: asIso(dt),
      end: asIso(de),
      timezone: zone,
      allDay: dt.isDate,
      recurrence: String(ownRule || c.getFirstPropertyValue("rrule") || ""),
      attendees: [],
      reminderMinutes: 15,
      excludedDates,
    });
  });
}

/** An emailed iTIP REPLY (RFC 5546): one VEVENT with one ATTENDEE. PARTSTAT is lowercased; throws on anything else. */
export function parseCalendarReply(input: string): { uid: string; attendee: string; partstat: string; recurrenceId?: string } {
  const root = new ICAL.Component(ICAL.parse(input));
  if (String(root.getFirstPropertyValue("method")).toUpperCase() !== "REPLY") throw new Error("Not a calendar reply");
  const events = root.getAllSubcomponents("vevent"),
    attendees = events[0]?.getAllProperties("attendee") || [];
  if (events.length !== 1 || attendees.length !== 1) throw new Error("A calendar reply needs exactly one event and one attendee");
  const recurrenceId = events[0].getFirstPropertyValue("recurrence-id");
  return {
    uid: String(events[0].getFirstPropertyValue("uid") || ""),
    attendee: String(attendees[0].getFirstValue()).replace(/^mailto:/i, "").trim().toLowerCase(),
    partstat: String(attendees[0].getParameter("partstat") || "").toLowerCase(),
    ...(recurrenceId ? { recurrenceId: String(recurrenceId) } : {}),
  };
}

export function contactFile(
  contacts: ContactInput[],
  format: "csv" | "vcf",
): string {
  if (format === "csv") {
    const cell = (s: string) =>
      '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
    return [
      "name,email,phone,company,notes,groups",
      ...contacts.map((c) =>
        [c.name, c.email, c.phone, c.company, c.notes, c.groups.join(";")]
          .map(cell)
          .join(","),
      ),
    ].join("\r\n");
  }
  return (
    contacts
      .map((c) => {
        const v = new ICAL.Component("vcard");
        v.addPropertyWithValue("version", "4.0");
        for (const [key, value] of [
          ["fn", c.name],
          ["email", c.email],
          ["tel", c.phone],
          ["org", c.company],
          ["note", c.notes],
        ])
          v.addPropertyWithValue(key, value);
        if (c.groups.length) {
          const p = new ICAL.Property("categories");
          p.setValues(c.groups);
          v.addProperty(p);
        }
        return v.toString();
      })
      .join("\r\n") + "\r\n"
  );
}
export function parseContacts(
  input: string,
  format: "csv" | "vcf",
): ContactInput[] {
  if (input.length > 1024 * 1024) throw new Error("Import must be under 1 MB");
  let rows: ContactInput[];
  if (format === "vcf") {
    const cards = input.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [];
    rows = cards.map((s) => {
      const c = new ICAL.Component(ICAL.parse(s));
      const get = (k: string) => String(c.getFirstPropertyValue(k) || "");
      return {
        name: get("fn"),
        email: get("email"),
        phone: get("tel"),
        company: get("org"),
        notes: get("note"),
        groups: (c.getFirstProperty("categories")?.getValues() || []).map(
          String,
        ),
      };
    });
  } else {
    const table: string[][] = [];
    let row: string[] = [],
      value = "",
      quoted = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '"') {
        if (quoted && input[i + 1] === '"') {
          value += '"';
          i++;
        } else quoted = !quoted;
      } else if (!quoted && (ch === "," || ch === "\n")) {
        row.push(value.replace(/\r$/, ""));
        value = "";
        if (ch === "\n") {
          table.push(row);
          row = [];
        }
      } else value += ch;
    }
    if (quoted) throw new Error("Unclosed CSV quote");
    if (value || row.length) {
      row.push(value.replace(/\r$/, ""));
      table.push(row);
    }
    const header =
      table.shift()?.map((s) =>
        s
          .replace(/^\uFEFF/, "")
          .toLowerCase()
          .trim(),
      ) || [];
    if (!header.includes("name") || !header.includes("email"))
      throw new Error("CSV needs name and email columns");
    rows = table
      .filter((r) => r.some(Boolean))
      .map((r) => {
        const get = (k: string) =>
          (r[header.indexOf(k)] || "").replace(/^'(?=[=+@\-\t\r])/, "");
        return {
          name: get("name"),
          email: get("email"),
          phone: get("phone"),
          company: get("company"),
          notes: get("notes"),
          groups: get("groups").split(";").filter(Boolean),
        };
      });
  }
  if (!rows.length || rows.length > 200)
    throw new Error("Import between 1 and 200 contacts at a time");
  return rows.map(validateContact);
}
