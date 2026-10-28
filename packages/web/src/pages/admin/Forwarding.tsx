import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import type { ForwardingPolicy } from '@email-service/shared';
import { forwardingApi } from '../../lib/api';
import { useAuthStore, useToastStore } from '../../stores';

export default function AdminForwarding() {
  const user = useAuthStore(s => s.user);
  const allowed = user?.role === 'super_admin';
  const query = useQuery({ queryKey: ['forwarding-policy', user?.id], queryFn: forwardingApi.policy, enabled: allowed });
  const [before, setBefore] = useState('');
  const audit = useQuery({ queryKey: ['forwarding-audit', user?.id, before], queryFn: () => forwardingApi.audit(before), enabled: allowed });
  const [draft, setDraft] = useState<ForwardingPolicy | null>(null);
  const [domains, setDomains] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToastStore(s => s.addToast);
  if (!allowed) return <Navigate to="/admin" replace />;
  const policy = draft || query.data?.data;
  return <div className="admin-page"><div className="admin-header"><div><h1>Forwarding controls</h1><p className="page-subtitle">Manage automatic forwarding across the organization.</p></div></div>
    <section className="settings-card">
      {!policy ? <p>{query.isError ? 'Could not load policy.' : 'Loading…'} <button className="btn btn-secondary" onClick={() => query.refetch()}>Refresh</button></p> : <form className="settings-form" onSubmit={async e => { e.preventDefault(); setBusy(true); try {
        await forwardingApi.savePolicy({ ...policy, allowedDomains: (domains ?? policy.allowedDomains.join(', ')).split(/[,\s]+/).map(d => d.trim().toLowerCase()).filter(Boolean) });
        await query.refetch(); setDraft(null); setDomains(null); await audit.refetch(); toast({ type: 'success', title: 'Forwarding policy saved' });
      } catch (err) { toast({ type: 'error', title: 'Could not save policy', body: (err as Error).message }); } finally { setBusy(false); } }}>
        <label className="forwarding-check"><input type="checkbox" checked={policy.enabled} onChange={e => setDraft({ ...policy, enabled: e.target.checked })} /> Allow automatic forwarding</label>
        <label className="forwarding-check"><input type="checkbox" checked={policy.allowExternal} onChange={e => setDraft({ ...policy, allowExternal: e.target.checked })} /> Allow forwarding outside our email domain</label>
        <label className="form-label" htmlFor="forward-domains">Allowed destination domains</label><textarea id="forward-domains" className="form-input" rows={3} placeholder="example.com, partner.com" value={domains ?? policy.allowedDomains.join(', ')} onChange={e => setDomains(e.target.value)} />
        <p className="page-subtitle">Leave empty to allow any domain permitted above. Domains match exactly. Restrictions are checked again before queued deliveries are sent; mail already being sent cannot be recalled. Folder, read and star filters remain available.</p>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button>
      </form>}
    </section>
    <section className="settings-card forwarding-audit"><div className="forwarding-heading"><div><h2>Change history</h2><p className="page-subtitle">Forwarding settings, administrator policies and delivery actions. Kept for 90 days.</p></div><button className="btn btn-secondary" onClick={() => audit.refetch()}>Refresh</button></div>
      {audit.isError ? <p role="alert">Could not load change history.</p> : <ul className="forwarding-activity">{audit.data?.data?.map(item => <li key={item.id}><div><strong>{item.actor_email}</strong><p>{item.action.replaceAll('_', ' ')} · {new Date(item.created_at).toLocaleString()}</p><details><summary>View change</summary><pre>{JSON.stringify(JSON.parse(item.details), null, 2)}</pre></details></div></li>)}</ul>}
      {!audit.isPending && !audit.data?.data?.length && <p className="forwarding-empty">No changes on this page.</p>}
      <div className="forwarding-inline">{before && <button className="btn btn-secondary" onClick={() => setBefore('')}>Newest changes</button>}{audit.data?.data?.length === 100 && <button className="btn btn-secondary" onClick={() => setBefore(audit.data!.data!.at(-1)!.id)}>Older changes</button>}</div>
    </section>
  </div>;
}
