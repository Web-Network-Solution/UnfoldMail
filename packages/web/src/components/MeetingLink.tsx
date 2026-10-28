import { meetingProviders, validateMeeting, type CalendarMeeting } from '@email-service/shared';
export default function MeetingLink({meeting,cancelled=false}:{meeting?:CalendarMeeting|null;cancelled?:boolean}) {
  if (!meeting) return null;
  let valid: CalendarMeeting | null; try {valid=validateMeeting(meeting);} catch {return <p role="alert">This meeting link is invalid. Ask the organizer for an updated invitation.</p>;}
  if (!valid) return null;
  return <div className="calendar-meeting"><strong>{meetingProviders[valid.provider]} meeting</strong><p className="productivity-note">{new URL(valid.url).hostname}</p>{!cancelled && <a className="btn btn-primary" href={valid.url} target="_blank" rel="noopener noreferrer" aria-label={`Join ${meetingProviders[valid.provider]} meeting (opens in a new tab)`}>Join meeting</a>}{valid.provider==='jitsi' && <p className="productivity-note">The host starts the room when joining. On meet.jit.si, the host must sign in.</p>}</div>;
}
