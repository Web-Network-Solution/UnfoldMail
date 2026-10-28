import MeetingLink from '../components/MeetingLink';
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { calendarApi } from "../lib/api";
import type { Attendance } from "@email-service/shared";
export default function CalendarResponse() {
  const [token] = useState(() => window.location.hash.slice(1));
  const result = useQuery({
    queryKey: ["invitation-response", token],
    queryFn: () => calendarApi.rsvp(token),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (response: Attendance) => calendarApi.rsvp(token, response),
    onSuccess: () => result.refetch(),
  });
  const e = result.data?.data;
  return (
    <main className="calendar-response">
      <div className="calendar-response-card">
        <span className="eyebrow">UNFOLDMAIL · CALENDAR INVITATION</span>
        {result.isLoading ? (
          <p role="status">Loading invitation…</p>
        ) : result.isError ? (
          <p role="alert">{result.error.message}</p>
        ) : (
          e && (
            <>
              <h1>{e.title}</h1>
              <p>From {e.organizer}</p>
              <p>
                {e.allDay
                  ? e.start.slice(0, 10)
                  : new Date(e.start).toLocaleString(undefined, {
                      timeZone: e.timezone,
                    })}{" "}
                · {e.timezone}
              </p>
              <p>{e.location}</p>
              <MeetingLink meeting={e.meeting} cancelled={e.status === "cancelled"}/>
              <p className="event-description">{e.description}</p>
              {e.recurrence && (
                <p>
                  This invitation repeats. Your response applies to the series.
                </p>
              )}
              <p>
                Responding as <strong>{e.email}</strong>
              </p>
              {e.status === "cancelled" ? (
                <p role="status">This event has been cancelled.</p>
              ) : (
                <>
                  <div className="productivity-actions">
                    {(
                      ["accepted", "tentative", "declined"] as Attendance[]
                    ).map((r) => (
                      <button
                        className={`btn ${e.response === r ? "btn-primary" : "btn-secondary"}`}
                        disabled={mutation.isPending}
                        key={r}
                        onClick={() => mutation.mutate(r)}
                      >
                        {r === "accepted"
                          ? "Accept"
                          : r === "tentative"
                            ? "Maybe"
                            : "Decline"}
                      </button>
                    ))}
                  </div>
                  <p role="status">
                    {e.response === "needs-action"
                      ? "Choose your response above."
                      : `Your response: ${e.response}`}
                  </p>
                </>
              )}
              {mutation.isError && (
                <p className="form-error" role="alert">
                  {mutation.error.message}
                </p>
              )}
            </>
          )
        )}
      </div>
    </main>
  );
}
