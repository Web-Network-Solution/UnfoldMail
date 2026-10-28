import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { meetingProviders, type MeetingProvider } from '@email-service/shared';
import { meetingPolicyApi } from '../../lib/api';
import { useAuthStore, useToastStore } from '../../stores';
export default function AdminMeetingProviders() {
  const user = useAuthStore(s => s.user), allowed = user?.role === 'super_admin';
  const query = useQuery({queryKey:['admin-meeting-providers',user?.id],queryFn:meetingPolicyApi.get,enabled:allowed});
  const cache = useQueryClient(), toast = useToastStore(s => s.addToast);
  const [draft,setDraft] = useState<MeetingProvider[] | null>(null), [busy,setBusy] = useState(false);
  if (!allowed) return <Navigate to="/admin" replace />;
  const selected = draft ?? query.data?.data;
  return <div className="admin-page"><div className="admin-header"><div><h1>Meeting providers</h1><p className="page-subtitle">Choose the virtual meeting options available across your organization.</p></div></div>
    <section className="settings-card">
      {!selected ? <div role="status"><p>{query.isError ? 'Could not load meeting providers.' : 'Loading meeting providers…'}</p>{query.isError && <button className="btn btn-secondary" onClick={() => query.refetch()}>Try again</button>}</div> :
      <form className="settings-form" onSubmit={async e => {e.preventDefault();setBusy(true);try {
        await meetingPolicyApi.save(selected); await query.refetch(); setDraft(null);
        await cache.invalidateQueries({queryKey:['meeting-providers']});
        toast({type:'success',title:'Meeting providers updated'});
      } catch(e) {toast({type:'error',title:'Could not save providers',body:(e as Error).message});} finally {setBusy(false);}}}>
        <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}><legend>Available providers</legend>
          {(Object.entries(meetingProviders) as [MeetingProvider,string][]).map(([id,label]) => <label key={id} style={{display:'flex',alignItems:'center',gap:'var(--space-3)',padding:'var(--space-4) 0',borderBottom:'1px solid var(--color-border)'}}>
            <input type="checkbox" checked={selected.includes(id)} onChange={e => setDraft(e.target.checked ? [...selected,id] : selected.filter(p => p !== id))}/><span>{label}</span>
          </label>)}
        </fieldset>
        <p className="page-subtitle">Disabled providers cannot be added to new events or selected as replacements. Existing event links remain available. Disable all providers to allow calendar events without virtual meeting links only.</p>
        <div style={{display:'flex',gap:'var(--space-3)'}}><button className="btn btn-primary" disabled={busy || draft === null}>{busy ? 'Saving…' : 'Save changes'}</button><button type="button" className="btn btn-secondary" disabled={busy || draft === null} onClick={() => setDraft(null)}>Discard changes</button></div>
      </form>}
    </section></div>;
}
