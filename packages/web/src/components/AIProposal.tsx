import { useEffect, useState } from 'react';
import type { AIAction, AITurn } from '@email-service/shared';
import { aiApi } from '../lib/ai';
import { emailApi } from '../lib/api';
import { useMailStore } from '../stores';

const titles={draft:'Email draft',send:'Send email',calendar:'Create event & invite attendees',contact:'Create contact',move:'Move email',read:'Change read status'};
export default function AIProposal({action:a,turn,enabled,busy,perform,onCompose}:{action:AIAction;turn:AITurn;enabled:boolean;busy:boolean;perform:(fn:()=>Promise<unknown>)=>Promise<void>;onCompose:()=>void}) {
  const mail=useMailStore(),isMail=a.kind==='draft'||a.kind==='send';
  const [editing,setEditing]=useState(false),[data,setData]=useState(a.data);
  useEffect(()=>{if(!editing)setData(a.data);},[a.data,editing]);
  const pending=a.status==='pending'&&turn.status==='complete';
  const openComposer=async()=>{
    // Approval here saves a draft only; the composer handles explicit sending.
    const updated=a.status==='applied'?turn:(await aiApi.decide(turn.id,a.id,true)).data;
    const applied=updated?.actions.find(v=>v.id===a.id);
    const result=applied?.result as {emailId?:string}|undefined;
    if(applied?.status!=='applied'||!result?.emailId)throw Error('Draft was not confirmed. Check Drafts before trying again.');
    const email=(await emailApi.get(result.emailId)).data;
    if(!email)throw Error('Draft could not be opened. Find it in Drafts.');
    if(useMailStore.getState().isComposeOpen)throw Error('Close your current compose window first. Your AI draft is saved in Drafts.');
    mail.openCompose({draft:email});onCompose();
  };
  return <section className="ai-proposal"><header className="ai-proposal-heading"><strong>{titles[a.kind]}</strong><span>{a.status==='pending'?'Needs your review':a.status}</span></header>
    {isMail?<>{editing?<div className="ai-draft-fields"><label>To<input type="email" value={String(data.to||'')} maxLength={254} onChange={e=>setData({...data,to:e.target.value})}/></label><label>Subject<input value={String(data.subject||'')} maxLength={998} onChange={e=>setData({...data,subject:e.target.value})}/></label><label>Message<textarea rows={9} value={String(data.body||'')} maxLength={16000} onChange={e=>setData({...data,body:e.target.value})}/></label><div className="ai-actions"><button className="btn btn-primary" disabled={busy||!enabled||!String(data.body||'').trim()} onClick={()=>perform(async()=>{await aiApi.editProposal(turn.id,a.id,{to:data.to,subject:data.subject,body:data.body});setEditing(false);})}>Save draft edits</button><button className="btn btn-secondary" onClick={()=>{setData(a.data);setEditing(false);}}>Discard edits</button></div></div>:<><dl className="ai-draft-envelope"><div><dt>To</dt><dd>{String(a.data.to)}</dd></div><div><dt>Subject</dt><dd>{String(a.data.subject)||'(No subject)'}</dd></div></dl><div className="ai-draft-body">{String(a.data.body)}</div></>}
      {a.review&&<div className="ai-review-note"><p role="status">{a.review.message}</p><details><summary>Original AI draft</summary><pre>{a.review.originalBody}</pre></details>{pending&&!editing&&a.review.originalBody!==a.data.body&&<button className="btn btn-secondary" disabled={busy} onClick={()=>{setData({...a.data,body:a.review!.originalBody});setEditing(true);}}>Restore original for review</button>}</div>}</>:<dl>{Object.entries(a.data).map(([k,v])=><div key={k}><dt>{k.replace(/([A-Z])/g,' $1')}</dt><dd>{typeof v==='object'?JSON.stringify(v):String(v)}</dd></div>)}</dl>}
    {pending&&!editing&&<div className="ai-actions"><button className="btn btn-primary" disabled={busy||!enabled} onClick={()=>perform(()=>aiApi.decide(turn.id,a.id,true))}>{a.kind==='send'?'Approve & send':a.kind==='draft'?'Approve & save draft':a.kind==='calendar'?'Approve & create event':'Approve action'}</button>{isMail&&<button className="btn btn-secondary" disabled={busy||!enabled} onClick={()=>setEditing(true)}>Edit draft</button>}<button className="btn btn-secondary" disabled={busy} onClick={()=>perform(()=>aiApi.decide(turn.id,a.id,false))}>Reject</button></div>}
    {a.kind==='draft'&&!editing&&(pending||a.status==='applied')&&<button className="btn btn-secondary" disabled={busy||!enabled||mail.isComposeOpen} title={mail.isComposeOpen?'Close your current compose window first':undefined} onClick={()=>perform(openComposer)}>{pending?'Save draft & open composer':'Open saved draft in composer'}</button>}
    {a.status==='uncertain'&&<p role="status">Outcome unconfirmed. Check the destination before repeating this action.</p>}
  </section>;
}
