import { instantFromWall, wallTime, validAddress, validateCalendar, type CalendarInput } from '@email-service/shared/productivity';
import { validateMeeting } from '@email-service/shared';
export type EventDraft = CalendarInput & {id?:string;revision?:number};
export type EditorState = {draft:EventDraft;start:string;end:string;attendees:string;repeat:string;count:string};
export function shiftDate(date:string, days:number) { return new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10); }
export function initialEditor(draft:EventDraft):EditorState {
 return {draft,start:draft.allDay?draft.start.slice(0,10):wallTime(draft.start,draft.timezone),end:draft.allDay?shiftDate(draft.end.slice(0,10),-1):wallTime(draft.end,draft.timezone),attendees:draft.attendees.join(', '),repeat:draft.recurrence?'custom':'',count:'12'};
}
export function editorPayload(s:EditorState):EventDraft {
 return {...s.draft,start:s.draft.allDay?s.start+'T00:00:00.000Z':instantFromWall(s.start,s.draft.timezone),end:s.draft.allDay?shiftDate(s.end,1)+'T00:00:00.000Z':instantFromWall(s.end,s.draft.timezone),attendees:s.attendees.split(/[,;]/).map(a=>a.trim()).filter(Boolean),recurrence:s.repeat==='custom'?s.draft.recurrence:s.repeat?`FREQ=${s.repeat};COUNT=${Number(s.count)}`:''};
}
export function editorErrors(s:EditorState):Record<string,string> {
 const e:Record<string,string>={};
 if(!s.draft.title.trim())e.title='Give your event a title.';
 if(s.draft.title.length>200)e.title='Use 200 characters or fewer.';
 if(s.draft.location.length>500)e.location='Use 500 characters or fewer.';
 if(s.draft.description.length>8000)e.description='Use 8,000 characters or fewer.';
 try{if(!s.draft.timezone.trim())throw Error();new Intl.DateTimeFormat('en',{timeZone:s.draft.timezone}).format();}catch{e.timezone='Choose a valid timezone, such as Asia/Kolkata.';}
 for(const key of ['start','end'] as const){
  if(!s[key]){e[key]='Choose a date'+(s.draft.allDay?'.':' and time.');continue;}
  if(!e.timezone)try{const iso=s.draft.allDay?new Date(s[key]+'T00:00:00Z').toISOString():instantFromWall(s[key],s.draft.timezone);if(iso<'2000'||iso>'2100')e[key]='Choose a date between 2000 and 2099.';}catch{e[key]='This time is invalid or ambiguous in this timezone. Choose another time.';}
 }
 if(!e.start&&!e.end&&!e.timezone){const p=editorPayload(s);if(Date.parse(p.end)<=Date.parse(p.start))e.end=s.draft.allDay?'The last day cannot be before the first day.':'End time must be after start time.';else if(Date.parse(p.end)-Date.parse(p.start)>366*86400000)e.end='An event can last up to one year.';}
 const people=s.attendees.split(/[,;]/).map(a=>a.trim()).filter(Boolean);
 if(people.length>50)e.attendees='Invite up to 50 people.';else if(people.some(a=>!validAddress(a)))e.attendees='Enter complete email addresses, separated by commas.';
 if(s.repeat&&s.repeat!=='custom'&&(!Number.isInteger(Number(s.count))||Number(s.count)<1||Number(s.count)>1000))e.count='Choose a whole number between 1 and 1,000.';
 try{validateMeeting(s.draft.meeting);}catch(err){e.meeting=(err as Error).message;}
 if(!Object.keys(e).length)try{validateCalendar(editorPayload(s));}catch(err){e.form=(err as Error).message;}
 return e;
}
export function readEditorDraft(storage:Pick<Storage,'getItem'>,key:string,value:EventDraft):EditorState|null {
 try{const raw=JSON.parse(storage.getItem(key)||'null');if(!raw||raw.version!==1||Date.now()-raw.savedAt>7*86400000)return null;
 const s=raw.state;if(!s||s.draft?.id!==value.id||s.draft?.revision!==value.revision)return null;
 if(!['start','end','attendees','repeat','count'].every(k=>typeof s[k]==='string')||!['title','description','location','timezone','recurrence'].every(k=>typeof s.draft[k]==='string')||typeof s.draft.allDay!=='boolean'||!Array.isArray(s.draft.attendees))return null;
 // Retain authoritative identity/revision; local draft data is never authorization.
 return {...s,draft:{...s.draft,id:value.id,revision:value.revision}};
 }catch{return null;}
}
