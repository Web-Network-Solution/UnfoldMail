import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { protocolApi, type ProtocolPolicy } from '../../lib/protocol';
import { useAuthStore } from '../../stores';
export default function AdminProtocolSettings() {
    const role = useAuthStore(s => s.user?.role);
    const q = useQuery({ queryKey: ['protocol-policy'], queryFn: protocolApi.policy, enabled: role === 'super_admin' }), cache = useQueryClient();
    const [value, setValue] = useState<ProtocolPolicy>({ imap: false, smtp: false, pop3: false, hostname: '' }), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [userSearch, setUserSearch] = useState('');
    const users = useQuery({ queryKey: ['protocol-users', userSearch], queryFn: () => protocolApi.users(userSearch), enabled: role === 'super_admin' });
    useEffect(() => { if (q.data)
        setValue(q.data.data); }, [q.data]);
    if (role !== 'super_admin')
        return <p>Super administrator access required.</p>;
    async function save(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); try {
        await protocolApi.save(value);
        await cache.invalidateQueries({ queryKey: ['protocol-policy'] });
        setMessage('Mail app settings saved. Active devices use the new policy on their next operation.');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save');
    }
    finally {
        setBusy(false);
    } }
    async function access(userID: string, enabled: boolean) { setBusy(true); setError(''); try {
        await protocolApi.access(userID, enabled);
        await cache.invalidateQueries({ queryKey: ['protocol-users'] });
        setMessage(enabled ? 'Protocol access restored for this user.' : 'Protocol access disabled for this user.');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not update access');
    }
    finally {
        setBusy(false);
    } }
    return <div className="admin-page"><h1>Mail app access</h1><p>Connect Outlook through your self-hosted gateway. Mail storage and delivery remain on Cloudflare.</p>{q.isError ? <p role="alert">Could not load settings. <button onClick={() => q.refetch()}>Retry</button></p> : q.isPending ? <p role="status">Loading…</p> : <><form className="settings-card" onSubmit={save}><h2>Enabled protocols</h2>{(['imap', 'smtp', 'pop3'] as const).map(k => <label key={k} className="preferences-check"><input type="checkbox" checked={value[k]} onChange={e => setValue({ ...value, [k]: e.target.checked })}/>{k.toUpperCase()} {k === 'imap' ? '— mailbox synchronization' : k === 'smtp' ? '— authenticated sending' : '— legacy inbox downloads'}</label>)}<div className="form-group"><label htmlFor="protocol-host">Gateway hostname</label><input id="protocol-host" className="form-input" placeholder="protocol.example.com" value={value.hostname} onChange={e => setValue({ ...value, hostname: e.target.value.trim() })}/></div><p className="preferences-hint">Configure the Worker secret, trusted TLS certificate and Coolify TCP ports before enabling protocols. POP3 deletion removes server copies permanently.</p><button className="btn btn-primary" disabled={busy}>Save protocol settings</button></form><section className="settings-card"><h2>Employee access</h2><label htmlFor="protocol-user-search">Find an employee</label><input id="protocol-user-search" className="form-input" placeholder="Name or email address" value={userSearch} onChange={e => setUserSearch(e.target.value)}/><p className="preferences-hint">Showing up to 50 accounts. Disabling access applies to all their mail apps.</p>{users.isPending ? <p>Loading employees…</p> : users.isError ? <p role="alert">Could not load employees.</p> : users.data?.data.map(u => <div key={u.id} className="preferences-profile"><strong>{u.display_name}</strong><p>{u.email}</p><button className="btn btn-secondary" disabled={busy} onClick={() => access(u.id, !u.enabled)}>{u.enabled ? 'Disable access' : 'Restore access'}</button></div>)}</section></>}{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</div>;
}
