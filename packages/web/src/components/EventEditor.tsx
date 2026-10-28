import Select, { SelectOption } from './ui/Select';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { meetingProviders, createJitsiMeeting, type CalendarInput, type MeetingProvider } from '@email-service/shared';
import { calendarApi, meetingPolicyApi } from '../lib/api';
import { editorErrors, editorPayload, initialEditor, readEditorDraft, type EventDraft, type EditorState } from '../lib/event-editor';
import { useAuthStore, useToastStore } from '../stores';
import ProductivityDialog from './ProductivityDialog';
import RecipientInput from './RecipientInput';

export default function EventEditor({value,onClose,onSaved}:{value:EventDraft;onClose:()=>void;onSaved:()=>void}) {
 const userId=useAuthStore(s=>s.user?.id), toast=useToastStore(s=>s.addToast);
 const key=`calendar-editor:${userId}:${value.id || 'new'}`;
 const [state,setState]=useState(()=>initialEditor(value));
 const [recovery,setRecovery]=useState<EditorState|null>(()=>{try{return readEditorDraft(sessionStorage,key,value);}catch{return null;}});
 const [touched,setTouched]=useState<Record<string,boolean>>({}),[submitted,setSubmitted]=useState(false);
 const [busy,setBusy]=useState(false),[closing,setClosing]=useState(false),[error,setError]=useState(''),[draftStatus,setDraftStatus]=useState('');
 const form=useRef<HTMLFormElement>(null),timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined),completed=useRef(false);
 const baseline=useRef(JSON.stringify(initialEditor(value)));
 const policy=useQuery({queryKey:['meeting-providers'],queryFn:meetingPolicyApi.available,staleTime:0});
 const enabled=policy.data?.data ?? [], {draft,start,end,attendees,repeat,count}=state;
 const errors=editorErrors(state), dirty=JSON.stringify(state)!==baseline.current;
 const disabledProvider=!!draft.meeting&&!!policy.data?.data&&!enabled.includes(draft.meeting.provider);
 if(disabledProvider && (draft.meeting?.provider!==value.meeting?.provider || draft.meeting?.url!==value.meeting?.url))errors.meeting='This provider is disabled. Choose an enabled provider or remove the meeting link.';
 const edit=(patch:Partial<EditorState>)=>setState(s=>({...s,...patch}));
 const update=(field:keyof CalendarInput,v:unknown)=>setState(s=>({...s,draft:{...s.draft,[field]:v}}));
 function persist() {
  if(completed.current)return true;
  try{sessionStorage.setItem(key,JSON.stringify({version:1,savedAt:Date.now(),state}));setDraftStatus('Draft saved in this browser tab');return true;}
  catch{setDraftStatus('Draft could not be saved. Keep this window open.');return false;}
 }
 useEffect(()=>{
  if(!dirty||recovery||busy||completed.current)return;
  persist();
 },[state,recovery,busy]);
 useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
 function close() {
  if(busy||closing)return;
  if(dirty&&!persist()){setError('Your browser could not save this draft. Copy your changes before closing.');return;}
  setClosing(true);timer.current=setTimeout(onClose,140);
 }
 const shown=(name:string)=>(touched[name]||submitted)?errors[name]:undefined;
 const attrs=(name:string)=>({id:`event-${name}`,name,'aria-invalid':!!shown(name),'aria-describedby':shown(name)?`event-${name}-error`:undefined});
 const issue=(name:string)=>shown(name)?<span className="event-field-error" id={`event-${name}-error`} aria-live="polite">{shown(name)}</span>:null;
 const field=(name:string,label:string,control:ReactNode,help?:string)=><div className="event-field"><label htmlFor={`event-${name}`}>{label}</label>{control}{help&&<p className="event-help">{help}</p>}{issue(name)}</div>;
 function changeStart(next:string) {
  let nextEnd=end;
  if(!draft.allDay&&next&&start&&end){const duration=Date.parse(end)-Date.parse(start);if(duration>0){const moved=new Date(Date.parse(next)+duration);if(Number.isFinite(+moved)){const pad=(n:number)=>String(n).padStart(2,'0');nextEnd=`${moved.getFullYear()}-${pad(moved.getMonth()+1)}-${pad(moved.getDate())}T${pad(moved.getHours())}:${pad(moved.getMinutes())}`;}}}
  if(draft.allDay&&next>end)nextEnd=next;
  edit({start:next,end:nextEnd});
 }
 return <ProductivityDialog title={value.id?'Edit event':'Create event'} className="event-editor-dialog" closing={closing} onClose={close}>
  <form ref={form} noValidate aria-busy={busy} onBlurCapture={e=>{const target=e.target as unknown as HTMLInputElement;const name=target.name||target.id.replace('event-','');if(name)setTouched(t=>({...t,[name]:true}));}}
   onSubmit={async e=>{e.preventDefault();if(busy)return;setSubmitted(true);setError('');
    if(Object.keys(errors).length){setError('Check the highlighted fields before saving.');requestAnimationFrame(()=>form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());return;}
    if(draft.meeting&&!policy.data?.data){setError('Meeting providers could not be loaded. Try again below.');return;}
    setBusy(true);try{await calendarApi.save(editorPayload(state));completed.current=true;try{sessionStorage.removeItem(key);}catch{}onSaved();}catch(err){setError((err as Error).message||'Could not save the event. Your draft is preserved.');}finally{setBusy(false);}}}>
   <div className="event-editor-intro"><span className="event-eyebrow">YOUR CALENDAR</span><p>Make time for what matters. Add the essentials, then invite your people.</p></div>
   {recovery&&<div className="event-draft-banner" role="status"><div><strong>You have an unfinished {value.id?'edit':'event'}</strong><p>Restore your saved draft or start with the current event details.</p></div><div className="event-inline-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>{setState(recovery);setRecovery(null);setTouched({});}}>Restore draft</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{try{sessionStorage.removeItem(key);}catch{}setRecovery(null);}}>Discard draft</button></div></div>}
   <fieldset className="event-editor-fields" disabled={busy||closing||!!recovery}>
    <section className="event-section" aria-labelledby="event-details-heading"><h3 id="event-details-heading">Event details</h3>
     {field('title','Event title',<input {...attrs('title')} autoFocus data-initial-focus className="form-input event-title-input" required maxLength={200} value={draft.title} onChange={e=>update('title',e.target.value)} placeholder="e.g. Weekly team catch-up"/>)}
     <div className="event-section-heading"><h3 id="event-time-heading">Date & time</h3><label className="event-check"><input type="checkbox" checked={draft.allDay} onChange={e=>{const allDay=e.target.checked;edit({draft:{...draft,allDay},start:allDay?start.slice(0,10):start+'T09:00',end:allDay?end.slice(0,10):end+'T10:00'});}}/>All day</label></div>
     <div className="event-two-columns">
      {field('start',draft.allDay?'First day':'Starts',<input {...attrs('start')} className="form-input" type={draft.allDay?'date':'datetime-local'} required value={start} onChange={e=>changeStart(e.target.value)}/>)}
      {field('end',draft.allDay?'Last day':'Ends',<input {...attrs('end')} className="form-input" type={draft.allDay?'date':'datetime-local'} required value={end} onChange={e=>edit({end:e.target.value})}/>)}
     </div>
     {draft.allDay&&<p className="event-help">Includes both the first and last day.</p>}
     {field('timezone','Timezone',<Select {...attrs('timezone')} className="form-input" required value={draft.timezone} onValueChange={selectedValue=>update('timezone',selectedValue)}>{Array.from(new Set([draft.timezone,'UTC',...(Intl as typeof Intl & {supportedValuesOf?:(key:string)=>string[]}).supportedValuesOf?.('timeZone')||['Asia/Kolkata','Europe/London','America/New_York','Asia/Singapore']])).sort().map(zone=><SelectOption key={zone} value={zone}>{zone}</SelectOption>)}</Select>, 'Type a timezone name while the list is open to jump to it. Changing the start keeps the event duration.')}
     {field('location','Location (optional)',<input {...attrs('location')} className="form-input" maxLength={500} value={draft.location} onChange={e=>update('location',e.target.value)} placeholder="Office, room or address"/>)}
     {field('description','Description (optional)',<textarea {...attrs('description')} className="form-input" rows={3} maxLength={8000} value={draft.description} onChange={e=>update('description',e.target.value)} placeholder="Agenda, preparation or notes for your guests"/>)}
    </section>
    <section className="event-section" aria-labelledby="event-guests-heading"><h3 id="event-guests-heading">Guests & meeting</h3>
     {field('attendees','Invite people (optional)',<RecipientInput id="event-attendees" invalid={!!shown('attendees')} describedBy={shown('attendees')?'event-attendees-error':'event-invite-help'} value={attendees} onChange={v=>edit({attendees:v})} placeholder="Search contacts or enter email addresses"/>)}
     <p className="event-help" id="event-invite-help">Up to 50 guests. Creating or updating this event sends invitations. Guests can see the guest list.</p>
     {field('provider','Online meeting',<Select {...attrs('provider')} className="form-input" disabled={!policy.data?.data} value={draft.meeting?.provider||''} onValueChange={selectedValue =>{update('meeting',selectedValue?{provider:selectedValue as MeetingProvider,url:''}:null);setTouched(t=>({...t,meeting:false}));}}><SelectOption value="">No online meeting</SelectOption>{disabledProvider&&<SelectOption value={draft.meeting!.provider} disabled>{meetingProviders[draft.meeting!.provider]} (existing link)</SelectOption>}{Object.entries(meetingProviders).filter(([id])=>enabled.includes(id as MeetingProvider)).map(([id,label])=><SelectOption key={id} value={id}>{label}</SelectOption>)}</Select>)}
     {policy.isPending&&<p className="event-help" role="status">Loading meeting providers…</p>}
     {policy.isError&&<p className="event-field-error" role="alert">Could not load providers. <button type="button" className="btn btn-secondary" onClick={()=>policy.refetch()}>Try again</button></p>}
     {policy.data?.data?.length===0&&<p className="event-help">Virtual meeting providers are disabled by your super admin.</p>}
     {disabledProvider&&<p className="event-help">This provider is disabled. Keep this existing link, remove it or choose an enabled provider.</p>}
     {draft.meeting&&<div className="event-meeting-box">{field('meeting',`${meetingProviders[draft.meeting.provider]} meeting link`,<input {...attrs('meeting')} className="form-input" type="url" required maxLength={2048} readOnly={disabledProvider} value={draft.meeting.url} onChange={e=>update('meeting',{...draft.meeting!,url:e.target.value})} placeholder="https://…"/>)}
      {draft.meeting.provider==='jitsi'&&enabled.includes('jitsi')&&!draft.meeting.url&&<button type="button" className="btn btn-secondary" onClick={()=>update('meeting',createJitsiMeeting())}>Generate Jitsi link</button>}
      <p className="event-help">{draft.meeting.provider==='jitsi'?'Generate a room link or paste your own. On meet.jit.si, the person starting the meeting signs in.':'Paste a link created in your meeting provider.'} Invitees receive this link; recurring events reuse it.</p>
     </div>}
    </section>
    <section className="event-section" aria-labelledby="event-options-heading"><h3 id="event-options-heading">Additional settings</h3><div className="event-two-columns">
     {field('repeat','Repeat',<Select {...attrs('repeat')} className="form-input" value={repeat} onValueChange={selectedValue =>edit({repeat:selectedValue})}><SelectOption value="">Does not repeat</SelectOption><SelectOption value="DAILY">Daily</SelectOption><SelectOption value="WEEKLY">Weekly</SelectOption><SelectOption value="MONTHLY">Monthly</SelectOption><SelectOption value="YEARLY">Yearly</SelectOption>{value.recurrence&&<SelectOption value="custom">Keep existing recurrence</SelectOption>}</Select>)}
     {field('reminder','Email reminder (for you)',<Select {...attrs('reminder')} className="form-input" value={draft.reminderMinutes??''} onValueChange={selectedValue =>update('reminderMinutes',selectedValue===''?null:Number(selectedValue))}><SelectOption value="">No reminder</SelectOption>{[0,5,15,30,60,1440,10080].map(n=><SelectOption key={n} value={n}>{n===0?'At start':n>=1440?`${n/1440} day(s) before`:`${n} minutes before`}</SelectOption>)}</Select>)}
    </div>{repeat&&repeat!=='custom'&&field('count','Number of occurrences',<input {...attrs('count')} className="form-input" type="number" min={1} max={1000} required value={count} onChange={e=>edit({count:e.target.value})}/>, 'Includes the first event. Changes apply to the whole series.')}</section>
   </fieldset>
   {(error||(submitted&&errors.form))&&<div className="event-submit-error" role="alert">{error||errors.form}</div>}
   <footer className="event-editor-footer"><div className="event-draft-status" role="status">{draftStatus||'Drafts stay in this browser tab. No invitations until you save the event.'}</div><div className="event-footer-actions">
    <button type="button" className="btn btn-ghost" disabled={busy||closing} onClick={close}>Cancel</button>
    <button type="button" className="btn btn-secondary" disabled={busy||closing||!!recovery} onClick={()=>{if(persist()){toast({type:'success',title:'Draft saved',body:'Open the event editor in this tab to restore it.'});close();}}}>Save draft</button>
    <button type="submit" className="btn btn-primary" disabled={busy||closing||!!recovery}>{busy?'Saving…':value.id?'Save changes':'Create event'}</button>
   </div></footer>
  </form>
 </ProductivityDialog>;
}
