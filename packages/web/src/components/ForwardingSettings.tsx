import Select, { SelectOption } from './ui/Select';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FilterConditions, ForwardingConfig, ForwardingPreview, MailFilter } from '@email-service/shared';
import { addressError, filterErrors } from '../lib/settings';
import { folderApi, forwardingApi } from '../lib/api';
import { useAuthStore, useToastStore } from '../stores';

const newRule = (): MailFilter => ({ id: crypto.randomUUID(), name: '', enabled: true, match: 'all', conditions: {}, actions: {}, stop: false });
export default function ForwardingSettings({ view = 'settings', hidden = false, onDirtyChange }: {view?: 'settings' | 'activity'; hidden?: boolean; onDirtyChange?: (dirty:boolean)=>void}) {
  const userId = useAuthStore(s => s.user?.id);
  const cache = useQueryClient();
  const toast = useToastStore(s => s.addToast);
  const key = ['forwarding', userId];
  const query = useQuery({ queryKey: key, queryFn: forwardingApi.get });
  const folders = useQuery({ queryKey: ['forwarding-folders', userId], queryFn: folderApi.list });
  const activity = useQuery({ queryKey: ['forwarding-activity', userId], queryFn: forwardingApi.activity, refetchInterval: !hidden && view === 'activity' ? 15_000 : false, enabled: !hidden && view === 'activity' });
  const [draft, setDraft] = useState<ForwardingConfig | null>(null);
  const [address, setAddress] = useState('');
  const [editor, setEditor] = useState<MailFilter | null>(null);
  const [preview, setPreview] = useState<ForwardingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<ForwardingConfig | null>(null);
  const [feedback, setFeedback] = useState('');
  const [saveError, setSaveError] = useState('');
  useEffect(() => { onDirtyChange?.(!!draft || !!editor || !!address || busy); }, [draft,editor,address,busy,onDirtyChange]);
  const errors = editor ? filterErrors(editor) : {};

  useEffect(() => { setDraft(null); setEditor(null); setPreview(null); setAddress(''); setUndo(null); setFeedback(''); setSaveError(''); }, [userId]);
  const config = draft || query.data?.data?.config;
  const policy = query.data?.data?.policy;
  const fail = (e: unknown) => toast({ type: 'error', title: 'Could not update forwarding', body: e instanceof Error ? e.message : 'Please try again.' });
  async function save(next: ForwardingConfig, restoring = false) {
    setBusy(true); setSaveError('');
    const previous = query.data?.data?.config;
    try {
      const result = await forwardingApi.save(next);
      if (result.data) { setDraft(null); cache.setQueryData(key, { ...query.data, data: { config: result.data, policy } }); }
      setUndo(restoring ? null : previous && result.data ? {...structuredClone(previous), revision: result.data.revision} : null);
      setFeedback(restoring ? 'Previous forwarding settings restored.' : 'Forwarding settings saved.');
      toast({ type: 'success', title: restoring ? 'Forwarding settings restored' : 'Forwarding settings saved' });
      await cache.invalidateQueries({ queryKey: key });
      return true;
    } catch (e) { setSaveError(e instanceof Error ? e.message : 'Could not save. Your draft is still here.'); fail(e); return false; } finally { setBusy(false); }
  }
  async function delivery(id: string, action: 'retry' | 'cancel', uncertain: boolean) {
    if (uncertain && action === 'retry' && !window.confirm('Delivery is uncertain. Retrying may send a duplicate. Have you checked with the recipient and want to retry?')) return;
    setBusy(true);
    try { await forwardingApi.delivery(id, action, uncertain); setFeedback(action === 'retry' ? 'Delivery scheduled for retry.' : 'Delivery cancelled.'); toast({type:'success',title:action === 'retry' ? 'Retry requested' : 'Delivery cancelled'}); await activity.refetch(); }
    catch (e) { fail(e); } finally { setBusy(false); }
  }
  if (query.isPending) return <section hidden={hidden} className="settings-card"><p role="status">Loading forwarding settings…</p></section>;
  if (!config) return <section hidden={hidden} className="settings-card"><p role="alert">Could not load forwarding settings.</p><button className="btn btn-secondary" onClick={() => query.refetch()}>Try again</button></section>;
  const updateRule = (patch: Partial<MailFilter>) => { if (editor) setEditor({ ...editor, ...patch }); setPreview(null); };
  const condition = (name: keyof FilterConditions, value: string | number | boolean | undefined) => {
    if (!editor) return;
    const conditions = { ...editor.conditions };
    if (value === '' || value === undefined) delete conditions[name];
    else Object.assign(conditions, { [name]: value });
    updateRule({ conditions });
  };
  const choices = folders.data?.data?.filter(f => ['inbox', 'custom', 'archive'].includes(f.type)) || [];
  const normalizedAddress = address.trim().toLowerCase();
  const addressIssue = address ? addressError(normalizedAddress) || (normalizedAddress === useAuthStore.getState().user?.email.toLowerCase() ? 'You cannot forward mail to yourself.' : config.destinations.includes(normalizedAddress) ? 'This address is already added.' : '') : '';
  return <div className="forwarding-settings" hidden={hidden}>
    {saveError && <p role="alert" className="preferences-error">{saveError}</p>}
    <p role="status" className="preferences-feedback">{feedback}</p>
    <div hidden={view !== 'settings'} className="preferences-forward-panels">
    <section className="settings-card">
      <div className="forwarding-heading"><div><h3>Automatic forwarding</h3><p className="page-subtitle">Organize incoming mail and send copies automatically. Your original emails stay in your mailbox.</p></div>{draft && <span className="forwarding-badge">Unsaved changes</span>}</div>
      {(!policy?.enabled || !policy.allowExternal || !!policy.allowedDomains.length) && <p className="forwarding-notice">{!policy?.enabled ? 'Automatic forwarding is disabled by your administrator. Folder, read and star rules still work.' : `Administrator restrictions: ${!policy.allowExternal ? 'internal addresses only. ' : ''}${policy.allowedDomains.length ? `Allowed domains: ${policy.allowedDomains.join(', ')}` : ''}`}</p>}
      <label className="form-label" htmlFor="forward-address">Forwarding addresses</label>
      <form className="forwarding-inline" onSubmit={e => { e.preventDefault(); const normalized = address.trim().toLowerCase(); if (normalized && !addressIssue && config.destinations.length < 10 && !busy) { setDraft({ ...config, destinations: [...config.destinations, normalized] }); setAddress(''); } }}>
        <input id="forward-address" className="form-input" type="email" placeholder="name@example.com" value={address} onChange={e => setAddress(e.target.value)} required maxLength={254} disabled={busy || !!editor} aria-invalid={!!addressIssue} aria-describedby="forward-address-help" />
        <button className="btn btn-secondary" disabled={busy || !!editor || !address || !!addressIssue || config.destinations.length >= 10}>Add address</button>
      </form>
      <p id="forward-address-help" className={addressIssue ? "preferences-field-error" : "preferences-hint"} aria-live="polite">{addressIssue || `${config.destinations.length} of 10 addresses added. Add an address, then save your changes.`}</p>
      <div className="forwarding-addresses">{config.destinations.map(dest => {
        const inUse = config.rules.some(r => r.actions.forwardTo?.includes(dest));
        return <div className="forwarding-address" key={dest}><span>{dest}</span><button type="button" aria-label={`Remove ${dest}`} title={inUse ? 'Remove this address from its filters first' : `Remove ${dest}`} disabled={busy || !!editor || inUse} onClick={() => setDraft({ ...config, destinations: config.destinations.filter(d => d !== dest), forwardAll: config.forwardAll === dest ? null : config.forwardAll })}>Remove</button></div>;
      })}</div>
      <label className="form-label" htmlFor="forward-all">Forward every new incoming email</label>
      <Select id="forward-all" className="form-input" value={config.forwardAll || ''} onValueChange={selectedValue => setDraft({ ...config, forwardAll: selectedValue || null })} disabled={busy}>
        <SelectOption value="">Off — use filters only</SelectOption>{config.destinations.map(d => <SelectOption key={d}>{d}</SelectOption>)}
      </Select>
      <p className="page-subtitle">Matching notifications and verification emails can be forwarded. Already-forwarded messages, automatic replies and bounces are not forwarded again. Large attachments are sent as permanent download links when needed.</p>

    </section>
    <section className="settings-card">
      <div className="forwarding-heading"><div><h3>Custom filters</h3><p className="page-subtitle">Run from top to bottom. The last matching folder action wins; read and star actions accumulate.</p></div><button className="btn btn-primary" disabled={busy || !!editor || config.rules.length >= 50} onClick={() => { setEditor(newRule()); setPreview(null); }}>New filter</button></div>
      {!config.rules.length && !editor && <p className="forwarding-empty">No filters yet. Create one to route invoices, organize reports, or forward selected mail.</p>}
      <ol className="forwarding-rules">{config.rules.map((rule, i) => <li key={rule.id}>
        <div><strong>{rule.name}</strong><span className="forwarding-badge">{rule.enabled ? 'Active' : 'Paused'}</span><p className="page-subtitle">{rule.actions.forwardTo?.length ? `Forward to ${rule.actions.forwardTo.join(', ')}. ` : ''}{rule.actions.folderId ? `Move to ${choices.find(f => f.id === rule.actions.folderId)?.name || 'missing folder'}. ` : ''}{rule.actions.archive ? 'Archive. ' : ''}{rule.actions.markRead ? 'Mark read. ' : ''}{rule.actions.star ? 'Star. ' : ''}{rule.stop ? 'Stop after this rule.' : ''}</p></div>
        <div className="forwarding-rule-buttons">
          <button className="btn btn-secondary btn-sm" disabled={busy || !!editor} onClick={() => { setEditor(structuredClone(rule)); setPreview(null); }}>Edit</button>
          <button className="btn btn-secondary btn-sm" disabled={busy || !!editor} onClick={() => setDraft({ ...config, rules: config.rules.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r) })}>{rule.enabled ? 'Pause' : 'Enable'}</button>
          {[-1, 1].map(delta => <button key={delta} className="btn btn-secondary btn-sm" aria-label={`${delta < 0 ? 'Move up' : 'Move down'} ${rule.name}`} disabled={busy || !!editor || i + delta < 0 || i + delta >= config.rules.length} onClick={() => { const rules = [...config.rules]; [rules[i], rules[i + delta]] = [rules[i + delta], rules[i]]; setDraft({ ...config, rules }); }}>{delta < 0 ? '↑' : '↓'}</button>)}
          <button className="btn btn-secondary btn-sm" disabled={busy || !!editor} onClick={() => setDraft({ ...config, rules: config.rules.filter(r => r.id !== rule.id) })}>Delete</button>
        </div>
      </li>)}</ol>
      {editor && <form className="forwarding-editor" onSubmit={async e => {
        e.preventDefault(); if (Object.keys(errors).length) return; const exists = config.rules.some(r => r.id === editor.id);
        const next = { ...config, rules: exists ? config.rules.map(r => r.id === editor.id ? editor : r) : [...config.rules, editor] };
        setDraft(next); setEditor(null); setPreview(null); setFeedback('Filter added to your draft. Save changes to apply it.');
      }}>
        <h4>{config.rules.some(r => r.id === editor.id) ? 'Edit filter' : 'Create filter'}</h4>
        <label className="form-label" htmlFor="filter-name">Filter name</label><input id="filter-name" className="form-input" value={editor.name} maxLength={80} required aria-invalid={!!errors.name} aria-describedby="filter-name-help" onChange={e => updateRule({ name: e.target.value })} />
        <p id="filter-name-help" className="preferences-field-error" aria-live="polite">{errors.name}</p>
        <label className="form-label" htmlFor="filter-match">Match</label><Select id="filter-match" className="form-input" value={editor.match} onValueChange={selectedValue => updateRule({ match: selectedValue as 'all' | 'any' })}><SelectOption value="all">All of these conditions</SelectOption><SelectOption value="any">Any of these conditions</SelectOption></Select>
        <div className="forwarding-fields">{([['from', 'From address'], ['fromDomain', 'From domain'], ['to', 'Recipient address'], ['subject', 'Subject contains'], ['contains', 'Subject or body contains'], ['excludes', 'Subject and body do not contain']] as const).map(([field, label]) => <label key={field} className="form-label">{label}<input className="form-input" value={editor.conditions[field] || ''} maxLength={field === 'from' || field === 'to' ? 254 : 200} aria-invalid={!!errors[field]} aria-describedby={`filter-${field}-help`} onChange={e => condition(field, e.target.value)} /><span id={`filter-${field}-help`} className="preferences-field-error" aria-live="polite">{errors[field]}</span></label>)}</div>
        <div className="forwarding-fields"><label className="form-label">Attachments<Select className="form-input" value={editor.conditions.hasAttachments === undefined ? '' : String(editor.conditions.hasAttachments)} onValueChange={selectedValue => condition('hasAttachments', selectedValue === '' ? undefined : selectedValue === 'true')}><SelectOption value="">Any</SelectOption><SelectOption value="true">Has attachments</SelectOption><SelectOption value="false">No attachments</SelectOption></Select></label>
          {(['minBytes','maxBytes'] as const).map(field => <label className="form-label" key={field}>{field === 'minBytes' ? 'Minimum' : 'Maximum'} size (KiB)<input type="number" min={0} max={25600} step={1} className="form-input" value={editor.conditions[field] === undefined ? '' : editor.conditions[field]! / 1024} aria-invalid={!!errors[field]} aria-describedby={`filter-${field}-help`} onChange={e => condition(field, e.target.value === '' ? undefined : Number(e.target.value) * 1024)} /><span id={`filter-${field}-help`} className="preferences-field-error" aria-live="polite">{errors[field]}</span></label>)}
        </div>
        <p className="page-subtitle">Text matching is case-insensitive and uses the exact phrase entered. Empty conditions match all new mail. “Any” includes the exclusion condition as an alternative.</p>
        <fieldset aria-describedby="filter-actions-help"><legend>Then do this</legend>
          <div className="forwarding-checks">{config.destinations.map(dest => <label key={dest}><input type="checkbox" checked={editor.actions.forwardTo?.includes(dest) || false} onChange={e => updateRule({ actions: { ...editor.actions, forwardTo: e.target.checked ? [...(editor.actions.forwardTo || []), dest] : editor.actions.forwardTo?.filter(d => d !== dest) } })} /> Forward to {dest}</label>)}</div>
          {!config.destinations.length && <p className="page-subtitle">Add a forwarding address above to use the forwarding action.</p>}
          <label className="form-label">Move to folder<Select className="form-input" value={editor.actions.folderId || ''} onValueChange={selectedValue => updateRule({ actions: { ...editor.actions, folderId: selectedValue || undefined, archive: selectedValue ? false : editor.actions.archive } })}><SelectOption value="">Keep current folder</SelectOption>{choices.map(f => <SelectOption key={f.id} value={f.id}>{f.name}</SelectOption>)}</Select></label>
          <div className="forwarding-checks">{([['archive', 'Archive (skip inbox)'], ['markRead', 'Mark as read'], ['star', 'Star']] as const).map(([field, label]) => <label key={field}><input type="checkbox" checked={!!editor.actions[field]} onChange={e => updateRule({ actions: { ...editor.actions, [field]: e.target.checked, ...(field === 'archive' && e.target.checked ? { folderId: undefined } : {}) } })} /> {label}</label>)}</div>
          <p id="filter-actions-help" className="preferences-field-error" aria-live="polite">{errors.actions}</p>
        </fieldset>
        <label className="forwarding-check"><input type="checkbox" checked={editor.stop} onChange={e => updateRule({ stop: e.target.checked })} /> Stop processing further filters after this matches</label>
        <div className="forwarding-inline"><button className="btn btn-secondary" type="button" disabled={busy || Object.keys(errors).length > 0} onClick={async () => { setBusy(true); try { const res = await forwardingApi.preview(editor); setPreview(res.data || null); } catch (e) { fail(e); } finally { setBusy(false); } }}>Preview matches</button><button className="btn btn-primary" disabled={busy || Object.keys(errors).length > 0}>Apply to draft</button><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => { setEditor(null); setPreview(null); }}>Cancel</button></div>
        {preview && <div className="forwarding-preview" aria-live="polite"><strong>{preview.matches.length} matches in {preview.scanned} recent messages</strong><p className="page-subtitle">Preview checks up to 25 recent received messages and never forwards them. {preview.skipped > 0 && `${preview.skipped} oversized or unavailable bodies skipped.`}</p><ul>{preview.matches.map(m => <li key={m.id}>{m.subject || '(no subject)'} <small>— {m.sender}</small></li>)}</ul></div>}
      </form>}

      <p className="page-subtitle">Filters apply only to new mail. “Forward every email” runs independently of filter order.</p>
    </section>
    <div className="preferences-savebar"><span>{editor ? 'Finish editing the filter above' : draft || address ? 'Unsaved forwarding changes' : 'Forwarding is up to date'}</span><div>{undo && !draft && !editor && <button className="btn btn-secondary" disabled={busy} onClick={()=>save(undo,true)}>Undo last save</button>}{(draft || editor || address) && <button className="btn btn-secondary" disabled={busy} onClick={()=>{setDraft(null);setEditor(null);setAddress('');setPreview(null);setFeedback('Unsaved changes discarded.');}}>Discard changes</button>}<button className="btn btn-primary" disabled={busy || !draft || !!editor || !!address} onClick={()=>save(config)}>{busy?'Saving…':'Save changes'}</button></div></div>
    {address && <p className="preferences-hint">Add or clear the address above before saving.</p>}
    </div>
    <section hidden={view !== 'activity'} className="settings-card"><div className="forwarding-heading"><div><h3>Recent deliveries</h3><p className="page-subtitle">Latest 100 deliveries. Temporary failures retry automatically; uncertain deliveries require your review.</p></div><button className="btn btn-secondary" onClick={() => activity.refetch()}>Refresh</button></div>
      {activity.isPending ? <p role="status">Loading delivery history…</p> : activity.isError ? <p role="alert">Could not load forwarding activity.</p> : !activity.data?.data?.length ? <p className="forwarding-empty">Forwarded messages will appear here.</p> : <ul className="forwarding-activity">{activity.data.data.map(job => <li key={job.id}><div><strong>{job.subject || '(no subject)'}</strong><p>{job.destination}</p><small>{new Date(job.created_at).toLocaleString()} · {job.status === 'queued' ? 'Waiting to send' : job.status === 'uncertain' ? 'Needs review' : job.status}</small>{job.error && <p className="forwarding-notice">{job.error}</p>}</div><div className="forwarding-rule-buttons">{['failed', 'uncertain'].includes(job.status) && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => delivery(job.id, 'retry', job.status === 'uncertain')}>Retry</button>}{['queued','failed','uncertain'].includes(job.status) && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => delivery(job.id, 'cancel', false)}>Cancel delivery</button>}</div></li>)}</ul>}
    </section>
  </div>;
}
