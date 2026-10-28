import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Email, CalendarInput } from "@email-service/shared";
import { attachmentApi, calendarApi, contactsApi } from "../lib/api";
import { useToastStore } from "../stores";
import ProductivityDialog from "./ProductivityDialog";

/** Explicit user action only: incoming calendar files never silently alter a user's calendar. */
export default function EmailProductivityActions({ email }: { email: Email }) {
  const toast = useToastStore((s) => s.addToast),
    cache = useQueryClient();
  const [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{
      content: string;
      events: CalendarInput[];
    } | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const fail = (e: unknown) =>
    toast({
      type: "error",
      title: "Could not complete action",
      body: e instanceof Error ? e.message : "Please try again",
    });
  const files = (email.attachments || []).filter(
    (a) =>
      a.mimeType?.startsWith("text/calendar") || /\.ics$/i.test(a.filename),
  );
  return (
    <>
      <div className="email-productivity-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await contactsApi.save({
                name: email.senderName || email.sender,
                email: email.sender,
                phone: "",
                company: "",
                notes: "",
                groups: [],
              });
              cache.invalidateQueries({ queryKey: ["contacts"] });
              cache.invalidateQueries({ queryKey: ["contact-suggestions"] });
              toast({ type: "success", title: "Sender saved to contacts" });
            } catch (e) {
              fail(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save sender to contacts
        </button>
        {files.map((a) => (
          <button
            className="btn btn-secondary btn-sm"
            key={a.id}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (a.size > 1024 * 1024)
                  throw new Error("Calendar file must be under 1 MB");
                const r = await fetch(attachmentApi.download(a.id), {
                  credentials: "include",
                });
                if (!r.ok) throw new Error("Cannot read calendar attachment");
                const content = await r.text(),
                  parsed = await calendarApi.preview(content, zone);
                setPreview({ content, events: parsed.data || [] });
              } catch (e) {
                fail(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add {a.filename} to calendar
          </button>
        ))}
      </div>
      {preview && (
        <ProductivityDialog
          title="Add to your calendar"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <div className="event-details">
            <p>
              Add these events as private copies. This does not send a response
              to the sender. Use the invitation’s response link to RSVP.
            </p>
            <ul className="import-preview">
              {preview.events.map((e, i) => (
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
              onClick={() => setPreview(null)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await calendarApi.import(preview.content, zone);
                  cache.invalidateQueries({ queryKey: ["calendar"] });
                  setPreview(null);
                  toast({ type: "success", title: "Added to calendar" });
                } catch (e) {
                  fail(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Adding…" : "Add events"}
            </button>
          </footer>
        </ProductivityDialog>
      )}
    </>
  );
}
