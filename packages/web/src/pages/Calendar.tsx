import EventEditor from '../components/EventEditor';
import MeetingLink from '../components/MeetingLink';
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CalendarInput,
  type CalendarEvent,
  type Attendance,
} from "@email-service/shared/productivity";
import { calendarApi, downloadProductivity, request } from "../lib/api";
import { useAuthStore, useToastStore } from "../stores";
import ProductivityDialog from "../components/ProductivityDialog";
import { IconCalendar } from "../components/Icons";

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayOffset = (d: Date, n: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
type Draft = CalendarInput & { id?: string; revision?: number };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function repeatSummary(rule: string) {
  const parts = Object.fromEntries(rule.split(';').map(p => p.split('=')));
  const frequency = ({DAILY:'day',WEEKLY:'week',MONTHLY:'month',YEARLY:'year'} as Record<string,string>)[parts.FREQ] || 'period';
  const interval = Number(parts.INTERVAL || 1);
  return `Every ${interval === 1 ? frequency : `${interval} ${frequency}s`}${parts.COUNT ? ` · ${parts.COUNT} occurrences` : parts.UNTIL ? ` · until ${parts.UNTIL.slice(0,4)}-${parts.UNTIL.slice(4,6)}-${parts.UNTIL.slice(6,8)}` : ''}`;
}

export default function Calendar() {
  const user = useAuthStore((s) => s.user),
    toast = useToastStore((s) => s.addToast),
    cache = useQueryClient(),
    file = useRef<HTMLInputElement>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [anchor, setAnchor] = useState(() => new Date()),
    [view, setView] = useState<"month" | "week" | "day">("month"),
    [selected, setSelected] = useState<{
      id: string;
      occurrence?: string;
    } | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [busy, setBusy] = useState(false),
    [importData, setImportData] = useState<{
      content: string;
      events: CalendarInput[];
    } | null>(null);
  const first =
    view === "month"
      ? new Date(anchor.getFullYear(), anchor.getMonth(), 1)
      : dayOffset(anchor, 0);
  const rangeStart =
    view === "day" ? first : dayOffset(first, -((first.getDay() + 6) % 7));
  const days = Array.from(
    { length: view === "month" ? 42 : view === "week" ? 7 : 1 },
    (_, i) => dayOffset(rangeStart, i),
  );
  const from = rangeStart.toISOString(),
    to = dayOffset(rangeStart, days.length).toISOString();
  const events = useQuery({
    queryKey: ["calendar", user?.id, from, to, showCancelled],
    queryFn: () => calendarApi.list(from, to, showCancelled),
    refetchInterval: 60000,
  });
  const details = useQuery({
    queryKey: ["calendar-event", user?.id, selected?.id],
    queryFn: () => calendarApi.get(selected!.id),
    enabled: !!selected,
    refetchInterval: 30000,
  });
  const event = details.data?.data;
  const deliveries = useQuery({
    queryKey: ["calendar-deliveries", user?.id, selected?.id],
    queryFn: () => calendarApi.deliveries(selected!.id),
    enabled: !!event && event.ownerId === user?.id,
    refetchInterval: 15000,
  });
  const refresh = () => {
    cache.invalidateQueries({ queryKey: ["calendar"] });
    cache.invalidateQueries({ queryKey: ["calendar-event"] });
    cache.invalidateQueries({ queryKey: ["calendar-deliveries"] });
  };
  const fail = (e: unknown) =>
    toast({
      type: "error",
      title: "Calendar",
      body: e instanceof Error ? e.message : "Operation failed",
    });
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function create(date = anchor) {
    const start = new Date(date);
    start.setHours(9, 0, 0, 0);
    if (localDay(date) === localDay(new Date())) {
      const nextSlot = new Date(Math.ceil((Date.now()+60000)/1800000)*1800000);
      start.setTime(nextSlot.getTime());
    }
    setDraft({
      title: "",
      description: "",
      location: "",
      start: start.toISOString(),
      end: new Date(+start + 3600000).toISOString(),
      timezone: zone(),
      allDay: false,
      recurrence: "",
      attendees: [],
      reminderMinutes: 15,
    });
  }
  async function preview(f: File) {
    if (f.size > 1024 * 1024) {
      fail(new Error("Choose a calendar file under 1 MB"));
      return;
    }
    setBusy(true);
    try {
      const content = await f.text(),
        r = await calendarApi.preview(content, zone());
      setImportData({ content, events: r.data || [] });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function move(n: number) {
    setAnchor(
      view === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + n, 1)
        : dayOffset(anchor, n * (view === "week" ? 7 : 1)),
    );
  }
  return (
    <section className="productivity-page calendar-page">
      <header className="productivity-heading">
        <div>
          <span className="eyebrow">MAKE TIME FOR WHAT MATTERS</span>
          <h1>Calendar</h1>
          <p>Plan your day. Keep everyone in the loop.</p>
        </div>
        <button className="btn btn-primary" onClick={() => create()}>
          + New event
        </button>
      </header>
      <div className="productivity-toolbar">
        <div className="productivity-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setAnchor(new Date())}
          >
            Today
          </button>
          <button
            className="btn btn-ghost"
            aria-label="Previous period"
            onClick={() => move(-1)}
          >
            ‹
          </button>
          <button
            className="btn btn-ghost"
            aria-label="Next period"
            onClick={() => move(1)}
          >
            ›
          </button>
          <h2 className="calendar-period">
            {anchor.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
              ...(view === "day" ? { day: "numeric" } : {}),
            })}
          </h2>
        </div>
        <div className="segmented-control">
          {(["month", "week", "day"] as const).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => setView(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="productivity-toolbar">
        <span className="productivity-note">
          Times shown in {zone()} · Reminders arrive by email
        </span>
        <label className="productivity-note">
          <input
            type="checkbox"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />{" "}
          Show cancelled
        </label>
        <div className="productivity-actions">
          <input
            hidden
            ref={file}
            type="file"
            accept=".ics,text/calendar"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void preview(f);
              e.target.value = "";
            }}
          />
          <button
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            Import calendar
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              downloadProductivity("/calendar/export", "calendar.ics").catch(
                fail,
              )
            }
          >
            Export .ics
          </button>
        </div>
      </div>
      {events.isLoading ? (
        <div className="productivity-empty" role="status">
          Loading your calendar…
        </div>
      ) : events.isError ? (
        <div className="productivity-empty" role="alert">
          <p>{events.error.message}</p>
          <button
            className="btn btn-secondary"
            onClick={() => events.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <div
          className={`calendar-grid calendar-${view}`}
          role="region"
          aria-label={`${view} calendar`}
        >
          {days.map((day) => {
            const key = localDay(day),
              end = dayOffset(day, 1);
            const items = (events.data?.data || []).filter((e) =>
              e.allDay
                ? e.occurrenceStart!.slice(0, 10) <= key &&
                  e.occurrenceEnd!.slice(0, 10) > key
                : +new Date(e.occurrenceStart!) < +end &&
                  +new Date(e.occurrenceEnd!) > +day,
            );
            return (
              <div
                className={`calendar-day ${localDay(new Date()) === key ? "is-today" : ""} ${day.getMonth() !== anchor.getMonth() ? "outside-month" : ""}`}
                key={key}
              >
                <button
                  className="calendar-day-label"
                  aria-label={`Create event on ${day.toLocaleDateString()}`}
                  onClick={() => create(day)}
                >
                  <span>
                    {day.toLocaleDateString(undefined, { weekday: "short" })}
                  </span>
                  <strong>{day.getDate()}</strong>
                </button>
                <div className="calendar-day-events">
                  {items.map((e) => (
                    <button
                      className={`calendar-event-chip ${e.status === "cancelled" ? "cancelled" : ""} ${e.ownerId !== user?.id ? "invited" : ""}`}
                      key={`${e.id}:${e.occurrenceStart}`}
                      onClick={() =>
                        setSelected({ id: e.id, occurrence: e.occurrenceStart })
                      }
                    >
                      <span>
                        {e.allDay
                          ? "All day"
                          : new Date(e.occurrenceStart!).toLocaleTimeString(
                              undefined,
                              { hour: "2-digit", minute: "2-digit" },
                            )}
                        {e.recurrence ? " ↻" : ""}
                      </span>
                      <strong>
                        {e.status === "cancelled" ? "Cancelled: " : ""}
                        {e.title}
                      </strong>
                      {view !== "month" && e.location && (
                        <small>{e.location}</small>
                      )}
                    </button>
                  ))}
                  {!items.length && view === "day" && (
                    <div className="productivity-empty">
                      <IconCalendar size={32} />
                      <p>A little space in your day.</p>
                      <button
                        className="btn btn-secondary"
                        onClick={() => create(day)}
                      >
                        Add an event
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {draft && (
        <EventEditor
          value={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            refresh();
            toast({
              type: "success",
              title: "Event saved",
              body: draft.attendees.length
                ? "Invitations will be sent shortly."
                : undefined,
            });
          }}
        />
      )}
      {selected && !draft && (
        <ProductivityDialog
          title="Event details"
          onClose={() => setSelected(null)}
        >
          {details.isLoading ? (
            <div className="productivity-empty">Loading event…</div>
          ) : details.isError ? (
            <div className="productivity-empty" role="alert">
              {details.error.message}
            </div>
          ) : (
            event && (
              <>
                <div className="event-details">
                  <span className="eyebrow">
                    {event.status === "cancelled"
                      ? "CANCELLED"
                      : event.ownerId === user?.id
                        ? "YOUR EVENT"
                        : "INVITATION"}
                  </span>
                  <h2>{event.title}</h2>
                  <p>
                    {event.allDay
                      ? (selected.occurrence || event.start).slice(0, 10)
                      : new Date(
                          selected.occurrence || event.start,
                        ).toLocaleString(undefined, {
                          timeZone: event.timezone,
                        })}{" "}
                    · {event.timezone}
                  </p>
                  <p>
                    Until{" "}
                    {event.allDay
                      ? `(exclusive) ${new Date(+new Date(selected.occurrence || event.start) + (+new Date(event.end) - +new Date(event.start))).toISOString().slice(0, 10)}`
                      : new Date(
                          event.recurrence && selected.occurrence
                            ? +new Date(selected.occurrence) +
                              (+new Date(event.end) - +new Date(event.start))
                            : event.end,
                        ).toLocaleString(undefined, {
                          timeZone: event.timezone,
                        })}
                  </p>
                  {event.recurrence && (
                    <p className="productivity-note">
                      {repeatSummary(event.recurrence)}. Editing applies to the entire
                      series.
                    </p>
                  )}
                  {event.excludedDates.length > 0 && (
                    <p className="productivity-note">
                      {event.excludedDates.length} occurrence(s) cancelled.
                    </p>
                  )}
                  <p>{event.location}</p>
                  <MeetingLink meeting={event.meeting} cancelled={event.status === "cancelled"}/>
                  <p className="event-description">{event.description}</p>
                  <p className="productivity-note">
                    Organized by {event.organizer}
                  </p>
                  {event.ownerId !== user?.id &&
                    event.status !== "cancelled" && (
                      <div className="productivity-actions">
                        {(
                          ["accepted", "tentative", "declined"] as Attendance[]
                        ).map((r) => (
                          <button
                            key={r}
                            disabled={busy}
                            className={`btn ${event.responses.find((a) => a.email === user?.email)?.response === r ? "btn-primary" : "btn-secondary"}`}
                            onClick={() =>
                              action(() => calendarApi.respond(event.id, r))
                            }
                          >
                            {r === "accepted"
                              ? "Accept"
                              : r === "tentative"
                                ? "Maybe"
                                : "Decline"}
                          </button>
                        ))}
                      </div>
                    )}
                  {event.responses.length > 0 && (
                    <div className="event-attendees">
                      <h3>Attendees</h3>
                      {event.responses.map((r) => (
                        <div key={r.email}>
                          <span>{r.email}</span>
                          <span
                            className={`response-badge response-${r.response}`}
                          >
                            {r.response === "needs-action"
                              ? "Awaiting response"
                              : r.response}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {event.ownerId === user?.id && (
                    <div className="event-deliveries">
                      <h3>Invitation & reminder delivery</h3>
                      {deliveries.isError ? (
                        <p role="alert">Could not load delivery status.</p>
                      ) : deliveries.data?.data?.length ? (
                        deliveries.data.data.map((j) => (
                          <div key={j.id}>
                            <span>
                              {j.recipient}
                              <small>
                                {j.kind} · {j.status}
                              </small>
                              {j.error && <small>{j.error}</small>}
                            </span>
                            {["failed", "uncertain"].includes(j.status) && (
                              <button
                                className="btn btn-ghost btn-sm"
                                disabled={busy}
                                onClick={() => {
                                  if (
                                    j.status === "uncertain" &&
                                    !confirm(
                                      "Delivery might already have succeeded. Retrying may send a duplicate. Continue?",
                                    )
                                  )
                                    return;
                                  void action(() =>
                                    calendarApi.retry(
                                      event.id,
                                      j.id,
                                      j.status === "uncertain",
                                    ),
                                  );
                                }}
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        ))
                      ) : (
                        <p className="productivity-note">
                          No recent deliveries.
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <footer>
                  <button
                    className="btn btn-secondary"
                    onClick={() =>
                      downloadProductivity(
                        `/calendar/${event.id}/export`,
                        "event.ics",
                      ).catch(fail)
                    }
                  >
                    Export .ics
                  </button>
                  {event.ownerId === user?.id &&
                    event.status === "cancelled" && (
                      <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => {
                          if (
                            confirm(
                              "Restore this event? Every attendee gets a new invitation and is asked to respond again.",
                            )
                          )
                            void action(() =>
                              request(`/calendar/${event.id}/restore`, {
                                method: "POST",
                                body: JSON.stringify({ revision: event.revision }),
                              }),
                            );
                        }}
                      >
                        Restore event
                      </button>
                    )}
                  {event.ownerId === user?.id &&
                    event.status !== "cancelled" && (
                      <>
                        <button
                          className="btn btn-ghost"
                          disabled={busy}
                          onClick={() => {
                            if (
                              confirm(
                                "Cancel this event and notify all attendees?",
                              )
                            )
                              void action(async () => {
                                await calendarApi.cancel(
                                  event.id,
                                  event.revision,
                                );
                                setSelected(null);
                              });
                          }}
                        >
                          Cancel {event.recurrence ? "series" : "event"}
                        </button>
                        {event.recurrence && selected.occurrence && (
                          <button
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={() => {
                              if (
                                confirm(
                                  "Cancel only this occurrence and notify attendees?",
                                )
                              )
                                void action(async () => {
                                  await calendarApi.cancel(
                                    event.id,
                                    event.revision,
                                    selected.occurrence,
                                  );
                                  setSelected(null);
                                });
                            }}
                          >
                            Cancel occurrence
                          </button>
                        )}
                        <button
                          className="btn btn-primary"
                          onClick={() => setDraft(event)}
                        >
                          Edit {event.recurrence ? "series" : "event"}
                        </button>
                      </>
                    )}
                </footer>
              </>
            )
          )}
        </ProductivityDialog>
      )}
      {importData && (
        <ProductivityDialog
          title="Import calendar"
          onClose={() => {
            if (!busy) setImportData(null);
          }}
        >
          <div className="event-details">
            <p>
              Add {importData.events.length} event(s) as private copies. No
              invitations will be sent. Importing the same file again creates
              additional copies.
            </p>
            <ul className="import-preview">
              {importData.events.map((e, i) => (
                <li key={i}>
                  <strong>{e.title}</strong>
                  <span>{e.start.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </div>
          <footer>
            <button
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setImportData(null)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const r = await calendarApi.import(
                    importData.content,
                    zone(),
                  );
                  setImportData(null);
                  toast({
                    type: "success",
                    title: `${r.data?.imported} events imported`,
                  });
                })
              }
            >
              {busy ? "Importing…" : "Import events"}
            </button>
          </footer>
        </ProductivityDialog>
      )}
    </section>
  );
}
