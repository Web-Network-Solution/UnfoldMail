export interface Contact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  groups: string[];
  revision: number;
  directory?: boolean;
}
export type ContactInput = Omit<Contact, "id" | "revision" | "directory">;
export type Attendance = "needs-action" | "accepted" | "tentative" | "declined";
export type MeetingProvider = 'zoom' | 'google-meet' | 'teams' | 'jitsi';
export interface CalendarMeeting { provider: MeetingProvider; url: string; }
export interface CalendarInput {
  meeting?: CalendarMeeting | null;
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
  recurrence: string;
  attendees: string[];
  reminderMinutes: number | null;
  excludedDates?: string[];
}
export interface CalendarEvent extends CalendarInput {
  id: string;
  uid: string;
  ownerId: string;
  organizer: string;
  revision: number;
  status: "confirmed" | "cancelled";
  responses: { email: string; response: Attendance }[];
  occurrenceStart?: string;
  occurrenceEnd?: string;
  excludedDates: string[];
}
export interface CalendarDelivery {
  id: string;
  recipient: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
}
