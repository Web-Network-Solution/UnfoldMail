import ProtocolSettings from '../components/ProtocolSettings';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { authApi } from '../lib/api';
import { useAuthStore, useThemeStore, useToastStore } from '../stores';
import { MIN_PASSWORD_LENGTH } from '@email-service/shared';
import EmailBody from '../components/EmailBody';
import ForwardingSettings from '../components/ForwardingSettings';
import { findSettings, onRemoteImagesChange, passwordFeedback, remoteImagesAllowed, setRemoteImagesAllowed, settingsSections, type SettingsSection } from '../lib/settings';
import '../styles/settings.css';

export default function Settings() {
  const cache = useQueryClient();
  const user = useAuthStore(s => s.user);
  const setUser = useAuthStore(s => s.setUser);
  const toast = useToastStore(s => s.addToast);
  const { theme, toggleTheme: toggle } = useThemeStore();
  const [params, setParams] = useSearchParams();
  const active = settingsSections.find(s => s.id === params.get('section'))?.id || 'account';
  const [search, setSearch] = useState('');
  const [signature, setSignature] = useState('');
  const [savedSignature, setSavedSignature] = useState('');
  const [undoSignature, setUndoSignature] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [themeDraft, setThemeDraft] = useState(theme);
  const images = useSyncExternalStore(onRemoteImagesChange, remoteImagesAllowed);
  const [imagesDraft, setImagesDraft] = useState(images);
  const [undoSystem, setUndoSystem] = useState<{theme: typeof theme; images: boolean} | null>(null);
  const [forwardDirty, setForwardDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({queryKey:['me'], queryFn:authApi.me});
  useEffect(() => { if (query.data?.data) { setSignature(query.data.data.signatureHtml || ''); setSavedSignature(query.data.data.signatureHtml || ''); } }, [query.data?.data?.id]);
  const passwordDirty = !!(currentPassword || newPassword || confirmPassword);
  const signatureDirty = signature !== savedSignature;
  const systemDirty = themeDraft !== theme || imagesDraft !== images;
  const dirty = signatureDirty || passwordDirty || systemDirty || forwardDirty;
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty,busy]);
  const {next: passwordHint, confirm: confirmHint} = passwordFeedback(currentPassword,newPassword,confirmPassword,MIN_PASSWORD_LENGTH);
  const choose = (id: SettingsSection) => { setParams({section:id}, {replace:true}); setSearch(''); setMessage(''); setError(''); requestAnimationFrame(() => heading.current?.focus()); };
  async function saveSignature(value: string, undo = false) {
    setBusy(true); setError(''); setMessage('');
    const previous = savedSignature;
    try {
      await authApi.updateSignature(value);
      setSavedSignature(value); setSignature(value); setUndoSignature(undo ? null : previous);
      if (user) setUser({...user,signatureHtml:value});
      cache.setQueryData(['me'], (old: typeof query.data) => old?.data ? {...old,data:{...old.data,signatureHtml:value}} : old);
      setMessage(undo ? 'Previous signature restored.' : 'Email signature saved.');
      toast({type:'success',title:undo ? 'Signature restored' : 'Signature saved'});
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not save. Your draft is still here.'); toast({type:'error',title:'Signature was not saved',body:e instanceof Error ? e.message : 'Try again.'}); }
    finally {setBusy(false);}
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault(); if (passwordHint || confirmHint || !currentPassword || !newPassword || !confirmPassword) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await authApi.resetPassword(currentPassword,newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setMessage('Password changed. Other devices have been signed out.'); toast({type:'success',title:'Password changed'});
    } catch(e) { setError(e instanceof Error ? e.message : 'Could not change password.'); }
    finally {setBusy(false);}
  }
  const current = settingsSections.find(s => s.id === active)!;
  return <div className="preferences-page">
    <a href="#settings-content" className="preferences-skip">Skip to settings</a>
    <header className="preferences-header"><div><span className="preferences-kicker">YOUR WORKSPACE</span><h1>Settings</h1><p>Make your mail work for you.</p></div><Link className="btn btn-secondary" to="/mail" onClick={e => { if ((dirty || busy) && !window.confirm('Leave settings and discard unsaved changes?')) e.preventDefault(); }}>← Back to Mail</Link></header>
    <div className="preferences-layout">
      <aside className="preferences-sidebar">
        <label htmlFor="settings-search" className="form-label">Find a setting</label>
        <input id="settings-search" type="search" className="form-input" placeholder="Search settings…" value={search} onChange={e=>setSearch(e.target.value)} aria-controls="settings-navigation" />
        <nav id="settings-navigation" aria-label={search ? 'Settings search results' : 'Settings categories'}>
          {findSettings(search).map(s => <button key={s.id} onClick={()=>choose(s.id)} aria-current={active===s.id ? 'page' : undefined}><span>{s.label}</span><small>{s.description}</small>{((s.id==='account' && signatureDirty)||(s.id==='security' && passwordDirty)||(s.id==='forwarding' && forwardDirty)||(s.id==='system' && systemDirty)) && <em>Unsaved changes</em>}</button>)}
        </nav>
        {search && <p role="status" className="preferences-hint">{findSettings(search).length ? `${findSettings(search).length} matching categories` : 'No settings found. Try “password”, “signature” or “forward”.'}</p>}
        <p className="preferences-sidebar-note">Changes stay in draft until you save. You can switch categories without losing your work.</p>
      </aside>
      <main id="settings-content" className="preferences-content" tabIndex={-1}>
        <div className="preferences-section-heading"><span className="preferences-kicker">PREFERENCES / {String(settingsSections.findIndex(s=>s.id===active)+1).padStart(2,'0')}</span><h2 ref={heading} tabIndex={-1}>{current.label}</h2><p>{current.description}</p></div>
        {error && <div className="preferences-error" role="alert">{error}</div>}
        <div role="status" className="preferences-feedback">{message}</div>
        <div hidden={active!=='account'}>
          {query.isPending ? <p role="status">Loading your account…</p> : query.isError ? <div role="alert">Could not load your account. <button className="btn btn-secondary" onClick={()=>query.refetch()}>Try again</button></div> : <>
          <section className="settings-card"><h3>Your profile</h3><p className="preferences-hint">Your administrator manages these account details.</p><dl className="preferences-profile"><div><dt>Display name</dt><dd>{query.data?.data?.displayName}</dd></div><div><dt>Email address</dt><dd>{query.data?.data?.email}</dd></div></dl></section>
          <section className="settings-card"><div><h3>Email signature</h3><p className="preferences-hint">Automatically added to messages you send.</p></div><label className="form-label" htmlFor="signature-html">Signature HTML</label><textarea id="signature-html" className="form-input signature-editor" rows={7} value={signature} onChange={e=>{setSignature(e.target.value);setMessage('');setError('');}} maxLength={10000} disabled={busy} aria-describedby="signature-help"/><p id="signature-help" className="preferences-hint">Use HTML for formatting. Leave empty to remove your signature. {signature.length.toLocaleString()} / 10,000 characters.</p><div className="signature-preview"><h4>Live preview</h4><EmailBody html={signature} theme="light" trusted fallback="Your signature preview will appear here."/></div></section>
          <div className="preferences-savebar"><span>{signatureDirty ? 'Unsaved signature changes' : 'Signature is up to date'}</span><div>{undoSignature!==null && !signatureDirty && <button className="btn btn-secondary" disabled={busy} onClick={()=>saveSignature(undoSignature,true)}>Undo last save</button>}{signatureDirty && <button className="btn btn-secondary" disabled={busy} onClick={()=>setSignature(savedSignature)}>Discard changes</button>}<button className="btn btn-primary" disabled={busy||!signatureDirty} onClick={()=>saveSignature(signature)}>{busy ? 'Saving…' : 'Save changes'}</button></div></div>
          </>}
        </div>
        <div hidden={active!=='security'}><form onSubmit={changePassword}>
          <section className="settings-card"><h3>Change password</h3><p className="preferences-hint">Use a unique password. Saving signs out other devices. A password change cannot be undone.</p>
          {([['current-password','Current password',currentPassword,setCurrentPassword,'current-password',''],['new-password','New password',newPassword,setNewPassword,'new-password',passwordHint],['confirm-password','Confirm new password',confirmPassword,setConfirmPassword,'new-password',confirmHint]] as const).map(([id,label,value,setValue,autocomplete,hint])=><div className="form-group" key={id}><label className="form-label" htmlFor={id}>{label}</label><input id={id} className="form-input" type={showPasswords?'text':'password'} autoComplete={autocomplete} value={value} onChange={e=>{setValue(e.target.value);setError('');}} required disabled={busy} aria-invalid={!!hint} aria-describedby={`${id}-help`}/><p id={`${id}-help`} className={hint?'preferences-field-error':'preferences-hint'} aria-live="polite">{hint || (id==='new-password' ? `At least ${MIN_PASSWORD_LENGTH} characters.` : '')}</p></div>)}
          <label className="preferences-check"><input type="checkbox" checked={showPasswords} onChange={e=>setShowPasswords(e.target.checked)}/> Show passwords</label></section>
          <div className="preferences-savebar"><span>{passwordDirty?'Password changes are not saved':'Keep your account secure'}</span><div>{passwordDirty && <button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>{setCurrentPassword('');setNewPassword('');setConfirmPassword('');setError('');}}>Discard changes</button>}<button className="btn btn-primary" disabled={busy||!!passwordHint||!!confirmHint||!currentPassword||!newPassword||!confirmPassword}>{busy?'Saving…':'Change password'}</button></div></div>
        </form></div>
        <ForwardingSettings view={active==='activity'?'activity':'settings'} hidden={active!=='forwarding' && active!=='activity'} onDirtyChange={setForwardDirty}/>
        {active==='mail-apps' && <ProtocolSettings/>}
        <div hidden={active!=='system'}><section className="settings-card"><h3>Appearance</h3><p className="preferences-hint">Choose the theme for this browser. Your mailbox content is unchanged.</p><fieldset className="preferences-themes"><legend>Color theme</legend>{(['dark','light'] as const).map(t=><label key={t} className={themeDraft===t?'selected':''}><span className={`preferences-theme-preview ${t}`} aria-hidden="true"><i/><i/><i/></span><span><input type="radio" name="theme" value={t} checked={themeDraft===t} onChange={()=>setThemeDraft(t)}/> {t==='dark'?'Dark':'Light'}</span></label>)}</fieldset></section><section className="settings-card"><h3>Images</h3><p className="preferences-hint">Images hosted elsewhere can tell a sender when and where you opened their message, so received mail hides them until you choose to show them. Your own messages always show images.</p><label className="preferences-check"><input type="checkbox" checked={imagesDraft} onChange={e=>setImagesDraft(e.target.checked)}/> Always show remote images in received mail</label></section><div className="preferences-savebar"><span>{systemDirty?'Unsaved system settings':'System settings are up to date'}</span><div>{undoSystem && !systemDirty && <button className="btn btn-secondary" onClick={()=>{if(theme!==undoSystem.theme)toggle();setRemoteImagesAllowed(undoSystem.images);setThemeDraft(undoSystem.theme);setImagesDraft(undoSystem.images);setUndoSystem(null);setMessage('Previous system settings restored.');}}>Undo last save</button>}{systemDirty && <button className="btn btn-secondary" onClick={()=>{setThemeDraft(theme);setImagesDraft(images);}}>Discard changes</button>}<button className="btn btn-primary" disabled={!systemDirty} onClick={()=>{setUndoSystem({theme,images});if(themeDraft!==theme)toggle();setRemoteImagesAllowed(imagesDraft);setMessage('System settings saved for this browser.');toast({type:'success',title:'System settings saved'});}}>Save changes</button></div></div></div>
      </main>
    </div>
  </div>;
}
