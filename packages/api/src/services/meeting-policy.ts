import { meetingProviders, type MeetingProvider, type CalendarMeeting } from '@email-service/shared';
import type { Env } from '../types';
export async function enabledMeetingProviders(env: Env): Promise<MeetingProvider[]> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='meeting_providers'").first<{value:string}>();
  if (!row) return Object.keys(meetingProviders) as MeetingProvider[];
  try {
    const value: unknown = JSON.parse(row.value);
    return Array.isArray(value) ? value.filter((v): v is MeetingProvider => typeof v === 'string' && Object.hasOwn(meetingProviders, v)) : [];
  } catch { return []; }
}
/** The only assertMeetingAllowed failure routes report as 400; a failed settings read is not the user's input. */
export class MeetingNotAllowed extends Error {}
export async function assertMeetingAllowed(env: Env, meeting?: CalendarMeeting | null, previous?: CalendarMeeting | null) {
  if (!meeting || (previous?.provider === meeting.provider && previous.url === meeting.url)) return;
  if (!(await enabledMeetingProviders(env)).includes(meeting.provider)) throw new MeetingNotAllowed('This meeting provider has been disabled by your super admin. Choose an enabled provider or remove the meeting link.');
}
