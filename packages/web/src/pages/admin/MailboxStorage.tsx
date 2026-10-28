import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { mailboxStorageApi } from '../../lib/api';
import { useAuthStore } from '../../stores';

export default function MailboxStorage() {
  const user=useAuthStore(s=>s.user),allowed=user?.role==='super_admin';
  const query=useQuery({queryKey:['mailbox-storage',user?.id],queryFn:mailboxStorageApi.list,enabled:allowed});
  const [search,setSearch]=useState('');
  if(!allowed)return <Navigate to="/admin" replace/>;
  const rows=(query.data?.data||[]).filter(r=>(r.email+' '+r.display_name).toLowerCase().includes(search.toLowerCase()));
  return <div className="admin-page">
    <div className="admin-header"><div><h1>Mailbox storage</h1><p className="page-subtitle">Every account uses a dedicated mailbox database. Message bodies and files are stored in R2.</p></div><button className="btn btn-secondary" onClick={()=>query.refetch()}>Refresh</button></div>
    <section className="settings-card" style={{marginBottom:'var(--space-5)'}}>
      <h2>Dedicated mailbox storage</h2><p>New accounts are provisioned automatically. Account settings, calendar and contacts remain in the shared database.</p>
      <p className="page-subtitle">Capacity and report summaries refresh approximately every 15 minutes. Dedicated mailboxes have a 10 GB database limit on Workers Paid.</p>
    </section>
    <label htmlFor="mailbox-search">Find an employee</label><input id="mailbox-search" className="form-input" type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name or email" style={{margin:'var(--space-2) 0 var(--space-4)',maxWidth:440}}/>
    {query.isError&&<p role="alert">Unable to load mailbox storage. Try Refresh.</p>}
    {query.isLoading&&<p role="status">Loading mailboxes…</p>}
    <div style={{display:'grid',gap:'var(--space-3)'}}>{rows.map(row=><section className="settings-card" key={row.id} aria-label={`Storage for ${row.email}`}>
      <div style={{display:'flex',flexWrap:'wrap',justifyContent:'space-between',gap:'var(--space-4)'}}><div style={{minWidth:0}}><h2 style={{marginBottom:'var(--space-1)'}}>{row.display_name}</h2><p style={{overflowWrap:'anywhere'}}>{row.email}</p><p>{row.state==='active'?'Dedicated mailbox':'Provisioning / recovery pending'}</p></div>
      {row.state==='active'&&<div><strong>{row.database_bytes===null?'Awaiting first summary':`${(row.database_bytes/1e6).toFixed(1)} MB of 10,000 MB`}</strong><p>{row.emails?.toLocaleString()??'—'} messages</p><meter aria-label="Mailbox database capacity" value={row.database_bytes||0} max={1e10} low={7e9} high={8.5e9} optimum={0}/>{(row.database_bytes||0)>=7e9&&<p role="status">Capacity is approaching the limit. Plan additional mailbox partitions.</p>}</div>}</div>
    </section>)}</div>
    {!query.isLoading&&!query.isError&&!rows.length&&<p>No matching employees.</p>}
  </div>;
}
