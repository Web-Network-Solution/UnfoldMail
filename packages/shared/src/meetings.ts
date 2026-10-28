import type { CalendarMeeting, MeetingProvider } from './types/productivity';
export const meetingProviders: Record<MeetingProvider,string> = {zoom:'Zoom','google-meet':'Google Meet',teams:'Microsoft Teams',jitsi:'Jitsi'};
export function validateMeeting(raw: unknown): CalendarMeeting | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new Error('Choose a meeting provider and enter its meeting link.');
  const m = raw as CalendarMeeting;
  if (!Object.hasOwn(meetingProviders,m.provider) || typeof m.url !== 'string' || m.url.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(m.url)) throw new Error('Enter a valid meeting link (up to 2,048 characters).');
  let u: URL; try { u = new URL(m.url); } catch { throw new Error('Enter a complete HTTPS meeting link.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname === '/' || !u.hostname.includes('.')) throw new Error('Use an HTTPS meeting link with a room path and no embedded username or password.');
  const host = u.hostname.toLowerCase();
  const belongs = (domain: string) => host === domain || host.endsWith('.'+domain);
  if ((m.provider === 'zoom' && !['zoom.us','zoom.com','zoomgov.com'].some(belongs)) || (m.provider === 'google-meet' && host !== 'meet.google.com') || (m.provider === 'teams' && !['teams.microsoft.com','teams.live.com','teams.cloud.microsoft'].some(belongs))) throw new Error(`Use a ${meetingProviders[m.provider]} meeting link, or choose the matching provider.`);
  return {provider:m.provider,url:u.href};
}
export function meetingText(meeting?: CalendarMeeting | null): string {
  return meeting ? `Join ${meetingProviders[meeting.provider]}: ${meeting.url}` : '';
}
export function createJitsiMeeting(): CalendarMeeting {
  return {provider:'jitsi',url:`https://meet.jit.si/UnfoldMail-${crypto.randomUUID()}`};
}
