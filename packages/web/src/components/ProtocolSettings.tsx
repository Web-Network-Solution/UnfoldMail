import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores';
import { protocolApi } from '../lib/protocol';
export default function ProtocolSettings() {
    const isImpersonating = useAuthStore(s => s.isImpersonating);
    const cache = useQueryClient(), q = useQuery({ queryKey: ['protocol-settings'], queryFn: protocolApi.settings });
    const [name, setName] = useState(''), [password, setPassword] = useState(''), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    async function create(e: React.FormEvent) { e.preventDefault(); setBusy(true); setError(''); setSecret(''); try {
        const r = await protocolApi.create(name, isImpersonating ? undefined : password);
        setSecret(r.data.password);
        setPassword('');
        setName('');
        await cache.invalidateQueries({ queryKey: ['protocol-settings'] });
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not create password');
    }
    finally {
        setBusy(false);
    } }
    async function revoke(id: string) { setBusy(true); setError(''); try {
        await protocolApi.revoke(id);
        await cache.invalidateQueries({ queryKey: ['protocol-settings'] });
        setNotice('Device password revoked. It can no longer access your mailbox.');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Could not revoke password');
    }
    finally {
        setBusy(false);
    } }
    if (q.isPending)
        return <p role="status">Loading connected apps…</p>;
    if (q.isError)
        return <p role="alert">Could not load connected apps. <button className="btn btn-secondary" onClick={() => q.refetch()}>Retry</button></p>;
    const data = q.data!.data, p = data.policy;
    return <><section className="settings-card"><h3>Outlook and other mail apps</h3><p className="preferences-hint">Use IMAP to keep folders and messages synchronized with webmail. Create a separate password for each device. Changing your account password invalidates all device passwords.</p>
 <dl className="preferences-profile"><div><dt>Server</dt><dd>{p.hostname || 'Not configured by your administrator'}</dd></div><div><dt>IMAP</dt><dd>{p.imap ? 'Port 993 · SSL/TLS' : 'Disabled'}</dd></div><div><dt>SMTP</dt><dd>{p.smtp ? 'Port 465 · SSL/TLS · Authentication required' : 'Disabled'}</dd></div><div><dt>POP3</dt><dd>{p.pop3 ? 'Port 995 · SSL/TLS' : 'Disabled'}</dd></div></dl>
 <p className="preferences-hint">Use your full email address as the username. POP3 can permanently delete server messages: enable “leave a copy on the server” in your mail app if you want to keep them.</p></section>
 <section className="settings-card"><h3>Create a device password</h3><form onSubmit={create}>{isImpersonating && <p className="preferences-hint" id="protocol-switch-help">As a super administrator, you can create a device password for the user you switched to without their account password.</p>}<div className="form-group"><label htmlFor="protocol-device">Device name</label><input id="protocol-device" className="form-input" maxLength={60} required placeholder="Office laptop · Outlook" value={name} onChange={e => setName(e.target.value)}/></div>{!isImpersonating && <div className="form-group"><label htmlFor="protocol-password">Current account password</label><input id="protocol-password" aria-describedby={isImpersonating ? "protocol-switch-help" : undefined} className="form-input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)}/></div>}<button className="btn btn-primary" disabled={busy || !name.trim() || (!isImpersonating && !password)}>{busy ? 'Working…' : 'Create device password'}</button>{error && <p role="alert">{error}</p>}</form>
 {secret && <div role="status" className="settings-card"><h4>Save this password now</h4><p>It is shown only once. Paste it into your mail app’s incoming and outgoing password fields.</p><code style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>{secret}</code><div className="form-actions"><button className="btn btn-secondary" onClick={async () => { try {
        await navigator.clipboard.writeText(secret);
        setNotice('Password copied.');
    }
    catch {
        setError('Could not copy. Select and copy the password manually.');
    } }}>Copy password</button><button className="btn btn-secondary" onClick={() => setSecret('')}>I have saved it</button></div></div>}
 </section><section className="settings-card"><h3>Your devices</h3>{data.passwords.length === 0 ? <p>No device passwords yet.</p> : data.passwords.map(d => <div key={d.id} className="preferences-profile"><strong>{d.name}</strong><p className="preferences-hint">{d.revoked_at ? 'Revoked' : d.last_used_at ? 'Last used ' + new Date(d.last_used_at).toLocaleString() : 'Not used yet'}</p>{!d.revoked_at && <button className="btn btn-secondary" disabled={busy} onClick={() => revoke(d.id)}>Revoke access</button>}</div>)}</section>{notice && <p role="status">{notice}</p>}</>;
}
