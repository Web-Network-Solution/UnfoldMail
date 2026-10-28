import { createRef, useState, type ReactElement } from 'react';
import { cleanup, render, renderHook, act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@email-service/shared';
import type { Editor } from '@tiptap/core';
import RichTextEditor, { type RichTextEditorHandle } from '../src/components/RichTextEditor';
import ComposeModal from '../src/components/ComposeModal';
import EmailView from '../src/components/EmailView';
import EmailBody from '../src/components/EmailBody';
import EmailList from '../src/components/EmailList';
import ImpersonationBanner from '../src/components/ImpersonationBanner';
import MailLayout from '../src/pages/MailLayout';
import AdminReports from '../src/pages/admin/Reports';
import { useWebSocket } from '../src/hooks/useWebSocket';
import { emailApi, authApi, folderApi } from '../src/lib/api';
import { useAuthStore, useMailStore, useThemeStore } from '../src/stores';
vi.mock('../src/components/AIQuickActions', () => ({ AIWriting: () => null, AIEmailActions: () => null }));
const large=vi.hoisted(()=>{const done=()=>Promise.resolve({downloadUrl:'https://mail.example.com/api/files/abc'});return {done,result:done};});
vi.mock('../src/lib/api', async importOriginal => ({ ...await importOriginal<object>(), attachmentApi: { download: (id: string) => '/api/attachments/' + id, upload: async () => ({ success: true, data: { r2Key: 'uploads/u/a.txt' } }), createLargeUpload: () => ({ start() {}, cancel: async () => {}, result: large.result() }) } }));
beforeEach(()=>{
  Range.prototype.getBoundingClientRect=()=>({x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0,toJSON:()=>({})});
  Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView=vi.fn();
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();useMailStore.setState(useMailStore.getInitialState());useAuthStore.setState({isImpersonating:false});large.result=large.done;});
const me={id:'u',email:'me@example.com',displayName:'Me',role:'employee'} as User;
const editorOf=async()=>((await screen.findByRole('textbox',{name:'Message body'})) as HTMLElement & {editor:Editor}).editor;
/** Routes fetch by path; unknown paths answer an empty success. A function route answers per call. */
const stubApi=(routes:Record<string,unknown>,status:Record<string,number>={})=>{
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>{const path=url.replace(/^\/api/,'').split('?')[0],route=routes[path],body=typeof route==='function'?await route(init):route;return body instanceof Response?body:new Response(JSON.stringify(body??{success:true,data:[]}),{status:status[path]??200});});
  vi.stubGlobal('fetch',fetch);return fetch;
};
const withClient=(ui:ReactElement)=><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{ui}</QueryClientProvider>;

it('keeps the typed body when the composer is minimized and restored',async()=>{
  useAuthStore.setState({user:me});
  useMailStore.getState().openCompose();
  render(withClient(<ComposeModal onClose={()=>{}}/>));
  const editor=await editorOf();act(()=>{editor.commands.insertContent('Keep this text');});
  expect(editor.getText()).toContain('Keep this text');
  fireEvent.click(screen.getByRole('button',{name:'Minimize'}));
  fireEvent.click(screen.getByRole('button',{name:'Maximize'}));
  await waitFor(async()=>expect((await editorOf()).getText()).toContain('Keep this text'));
});

it('inserts a large-file link that survives the editor schema and reaches text/plain',async()=>{
  useAuthStore.setState({user:{...me,signatureHtml:'<p>Regards</p>'}});
  useMailStore.getState().openCompose();
  const {container}=render(withClient(<ComposeModal onClose={()=>{}}/>));
  const editor=await editorOf();
  const file=new File(['x'],'big.zip');Object.defineProperty(file,'size',{value:30*1024*1024});
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[file]}});
  await waitFor(()=>expect(editor.getHTML()).toContain('href="https://mail.example.com/api/files/abc"'));
  // One paragraph, with the signature marker intact so the server does not append a second copy.
  expect(editor.getHTML()).toMatch(/<p>📎 <a [^>]*>big\.zip<\/a> \(30\.0 MB\)<\/p>/);
  expect(editor.getHTML()).toContain('data-signature="true"');
});

it('keeps link targets in the text/plain body',()=>{
  const change=vi.fn();
  render(<RichTextEditor initialHtml={'<p>Get <a href="https://example.com/f">the <strong>file</strong></a> or <a href="https://example.com/">https://example.com/</a></p>'} onChange={change}/>);
  expect(change.mock.lastCall![0].text).toBe('Get the file <https://example.com/f> or https://example.com/');
});

it('signs the tab out on a 401 from a data endpoint, but not from /auth/*',async()=>{
  useAuthStore.setState({user:me});
  stubApi({},{'/auth/reset-password':401,'/auth/me':401,'/folders':401});
  await expect(authApi.resetPassword('wrong','new-password')).rejects.toThrow();
  await expect(authApi.me()).rejects.toThrow();
  await expect(emailApi.list({})).resolves.toBeTruthy();
  expect(useAuthStore.getState().user).toBe(me);
  await expect(folderApi.list()).rejects.toMatchObject({status:401});
  expect(useAuthStore.getState().user).toBeNull();
});

it('deletes permanently, after confirmation, only from Trash',async()=>{
  const email={id:'e1',folderId:'trash',subject:'Old',sender:'a@example.com',recipientsTo:[],recipientsCc:[],receivedAt:new Date().toISOString(),attachments:[]};
  const fetch=stubApi({'/emails/e1':{success:true,data:email},'/folders':{success:true,data:[{id:'trash',type:'trash',name:'Trash'},{id:'inbox',type:'inbox',name:'Inbox'}]}});
  const confirm=vi.fn(()=>false);vi.stubGlobal('confirm',confirm);
  render(withClient(<EmailView emailId="e1" onClose={()=>{}}/>));
  const button=await screen.findByTitle('Delete forever');
  fireEvent.click(button);expect(confirm).toHaveBeenCalled();
  expect(fetch.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(false);
  confirm.mockReturnValue(true);fireEvent.click(button);
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith('/api/emails/e1?permanent=true',expect.objectContaining({method:'DELETE'})));
});

it('draws mail on a light canvas, opaque white in dark theme, and never grants script or same-origin',()=>{
  act(()=>useThemeStore.setState({theme:'light'}));
  const {container,rerender}=render(<EmailBody html="<p>Hi</p>"/>);
  const doc=()=>container.querySelector('iframe')!.getAttribute('srcdoc')!;
  expect(doc()).toContain('color-scheme: light');expect(doc()).not.toContain('html { background: #fff; }');
  // Inline dark sender colors stay readable: no dark scheme, no recolored text on the dark app background.
  act(()=>useThemeStore.setState({theme:'dark'}));
  expect(doc()).toContain('color-scheme: light');expect(doc()).not.toContain('color-scheme: dark');expect(doc()).toContain('html { background: #fff; }');
  rerender(<EmailBody html="<p>Hi</p>" theme="light"/>);expect(doc()).not.toContain('html { background: #fff; }');
  expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-popups');
});

it('opens compose from the manifest shortcut and drops the parameter',async()=>{
  useAuthStore.setState({user:me});stubApi({});
  function Search(){return <output data-testid="search">{useLocation().search}</output>;}
  render(withClient(<MemoryRouter initialEntries={['/mail?action=compose']}><MailLayout/><Search/></MemoryRouter>));
  await waitFor(()=>expect(useMailStore.getState().isComposeOpen).toBe(true));
  await waitFor(()=>expect(screen.getByTestId('search').textContent).toBe(''));
});

it('neutralizes spreadsheet formulas in the report CSV',async()=>{
  stubApi({'/admin/reports':{success:true,data:{startDate:'2026-01-01',endDate:'2026-01-02',summary:{},daily:[],users:[{email:'x@example.com',displayName:'=HYPERLINK("https://evil.example","x")',role:'employee',sent:1,received:2,totalEmails:3,storageUsedBytes:4}]}}});
  const blobs:Blob[]=[];
  vi.spyOn(URL,'createObjectURL').mockImplementation(b=>{blobs.push(b as Blob);return 'blob:report';});vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  render(withClient(<MemoryRouter><AdminReports/></MemoryRouter>));
  const exportButton=await screen.findByRole('button',{name:/Export CSV/});
  await waitFor(()=>expect((exportButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(exportButton);
  const csv=await new Promise<string>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as string);reader.readAsText(blobs[0]);});
  expect(csv).toContain(`"x@example.com","'=HYPERLINK(""https://evil.example"",""x"")","employee",1,2,3,4`);
});

it('probes the session once on a revoked-session close, and ignores a probe answered for an earlier identity',async()=>{
  class Socket{static OPEN=1;static instances:Socket[]=[];readyState=1;onopen:(()=>void)|null=null;onclose:((e:{code:number})=>void)|null=null;onmessage=null;onerror=null;send=vi.fn();close=vi.fn();constructor(){Socket.instances.push(this);}}
  vi.stubGlobal('WebSocket',Socket);
  let answer!:()=>void;const fetch=stubApi({'/auth/me':()=>new Promise(resolve=>{answer=()=>resolve(new Response('{}',{status:401}));})});
  const cache=new QueryClient(),invalidate=vi.spyOn(cache,'invalidateQueries');
  const view=renderHook(()=>useWebSocket('u'),{wrapper:({children})=><QueryClientProvider client={cache}>{children}</QueryClientProvider>});
  act(()=>Socket.instances[0].onclose?.({code:1006}));expect(fetch).not.toHaveBeenCalled();
  const target={...me,id:'t'},admin={...me,id:'admin'};
  // Switch Back: the old session's socket closes with 4001 before the admin cookie is back.
  useAuthStore.setState({user:target,isImpersonating:true});
  act(()=>Socket.instances[0].onclose?.({code:4001}));
  expect(invalidate).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
  useAuthStore.getState().stopImpersonation();useAuthStore.getState().setUser(admin);
  await act(async()=>answer());
  expect(useAuthStore.getState().user).toBe(admin);
  // A real revocation of the current session signs out.
  act(()=>Socket.instances[0].onclose?.({code:4001}));
  await act(async()=>answer());
  await waitFor(()=>expect(useAuthStore.getState().user).toBeNull());
  view.unmount();
});

it('ignores a late 401 sent under an earlier identity, and never signs out while a composer is mounted',async()=>{
  let answer!:()=>void;
  stubApi({'/folders':()=>new Promise(resolve=>{answer=()=>resolve(new Response('{}',{status:401}));})});
  useAuthStore.setState({user:{...me,id:'t'},isImpersonating:true});
  const late=folderApi.list();await waitFor(()=>expect(answer).toBeDefined());
  useAuthStore.getState().stopImpersonation();useAuthStore.getState().setUser(me);
  answer();await expect(late).rejects.toMatchObject({status:401});
  expect(useAuthStore.getState().user).toBe(me);
  useMailStore.getState().openCompose();
  const view=render(withClient(<ComposeModal onClose={()=>{}}/>));await editorOf();
  const composing=folderApi.list();answer();await expect(composing).rejects.toMatchObject({status:401});
  expect(useAuthStore.getState().user).toBe(me);
  // Leaving /mail unmounts the composer but leaves the store's isComposeOpen set; that must not block sign-out.
  view.unmount();expect(useMailStore.getState().isComposeOpen).toBe(true);
  const closed=folderApi.list();answer();await expect(closed).rejects.toMatchObject({status:401});
  expect(useAuthStore.getState().user).toBeNull();
});

it('clears a stale impersonation flag on a fresh sign-in',async()=>{
  useAuthStore.setState({user:null,isImpersonating:true,impersonatingEmail:'x@example.com'});
  stubApi({'/auth/login':{success:true,data:{user:me}}});
  await authApi.login(me.email,'password');
  expect(useAuthStore.getState()).toMatchObject({isImpersonating:false,impersonatingEmail:''});
});

it('reloads when the revoked-session probe answers for another user, unless this tab changed identity itself',async()=>{
  class Socket{static OPEN=1;static instances:Socket[]=[];readyState=1;onopen:(()=>void)|null=null;onclose:((e:{code:number})=>void)|null=null;onmessage=null;onerror=null;send=vi.fn();close=vi.fn();constructor(){Socket.instances.push(this);}}
  vi.stubGlobal('WebSocket',Socket);
  const reload=vi.fn();vi.stubGlobal('location',{...window.location,reload});
  let answer!:(id:string)=>void;stubApi({'/auth/me':()=>new Promise(resolve=>{answer=id=>resolve(new Response(JSON.stringify({success:true,data:{...me,id}})));})});
  const target={...me,id:'t'};useAuthStore.setState({user:target,isImpersonating:true});
  const view=renderHook(()=>useWebSocket('t'),{wrapper:({children})=><QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>});
  const probe=async(id:string,meanwhile=()=>{})=>{act(()=>Socket.instances[0].onclose?.({code:4001}));meanwhile();await act(async()=>answer(id));};
  // Still the same user: nothing to do.
  await probe('t');expect(reload).not.toHaveBeenCalled();
  // This tab ran Switch Back itself: its identity changed before the answer landed.
  await probe('admin',()=>useAuthStore.getState().stopImpersonation());expect(reload).not.toHaveBeenCalled();
  // Another tab switched back: the shared cookie now speaks for the admin.
  useAuthStore.setState({user:target,isImpersonating:true});
  await probe('admin');expect(reload).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('on a Switch Back rotation (4002) probes later, never signs out on it, and reloads for another user',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  class Socket{static OPEN=1;static instances:Socket[]=[];readyState=1;onopen:(()=>void)|null=null;onclose:((e:{code:number})=>void)|null=null;onmessage=null;onerror=null;send=vi.fn();close=vi.fn();constructor(){Socket.instances.push(this);}}
  vi.stubGlobal('WebSocket',Socket);
  const reload=vi.fn();vi.stubGlobal('location',{...window.location,reload});
  let status=401;const fetch=stubApi({'/auth/me':()=>Promise.resolve(status===401?new Response('{}',{status:401}):new Response(JSON.stringify({success:true,data:{...me,id:'admin'}})))});
  const target={...me,id:'t'};useAuthStore.setState({user:target,isImpersonating:true});
  const view=renderHook(()=>useWebSocket('t'),{wrapper:({children})=><QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>});
  const settle=async()=>{await act(async()=>{await vi.advanceTimersByTimeAsync(1500);for(let i=0;i<20;i++)await Promise.resolve();});};
  act(()=>Socket.instances[0].onclose?.({code:4002}));
  expect(fetch).not.toHaveBeenCalled();
  // The probe landed before the new cookie: a 401 here is the old session, not a sign-out.
  await settle();expect(fetch).toHaveBeenCalledTimes(1);expect(useAuthStore.getState().user).toBe(target);
  status=200;act(()=>Socket.instances[0].onclose?.({code:4002}));
  await settle();expect(reload).toHaveBeenCalledTimes(1);
  view.unmount();vi.useRealTimers();
});

it('lists starred mail while the Threads view is selected',async()=>{
  useMailStore.setState({view:'threads'});
  stubApi({'/emails':{success:true,data:[{id:'s1',subject:'Starred one',sender:'a@example.com',recipientsTo:[],receivedAt:new Date().toISOString(),isRead:true,isStarred:true}],pagination:{page:1,pageSize:25,total:1,totalPages:1}}});
  render(withClient(<EmailList folderId="inbox" folderName="Starred" folderType="starred" starred selectedEmailId={null} selectedThreadId={null} onSelectEmail={()=>{}} onSelectThread={()=>{}}/>));
  expect(await screen.findByText('Starred one')).toBeTruthy();
});

it('really signs out when switching back from impersonation fails',async()=>{
  useAuthStore.setState({user:me,isImpersonating:true,impersonatingEmail:'x@example.com'});
  stubApi({},{'/auth/stop-impersonate':401});
  render(withClient(<MemoryRouter><ImpersonationBanner/></MemoryRouter>));
  fireEvent.click(screen.getByRole('button',{name:/Switch Back/}));
  await waitFor(()=>expect(useAuthStore.getState().user).toBeNull());
  expect(useAuthStore.getState().isImpersonating).toBe(false);
});

it('ends the server sessions when Switch Back fails on the network or a 5xx, but not on a 4xx',async()=>{
  const cases=[[{},400,false],[{},503,true],[{'/auth/stop-impersonate':()=>Promise.reject(new TypeError('Failed to fetch'))},200,true]] as const;
  for(const [routes,status,ends] of cases){
    useAuthStore.setState({user:me,isImpersonating:true,impersonatingEmail:'x@example.com'});
    const fetch=stubApi(routes,{'/auth/stop-impersonate':status});
    render(withClient(<MemoryRouter><ImpersonationBanner/></MemoryRouter>));
    fireEvent.click(screen.getByRole('button',{name:/Switch Back/}));
    await waitFor(()=>expect(useAuthStore.getState().user).toBeNull());
    expect(fetch.mock.calls.some(([url])=>url==='/api/auth/logout'),`status ${status}`).toBe(ends);
    cleanup();
  }
});

it('locks attachment removal while a draft save is in flight',async()=>{
  useAuthStore.setState({user:me});useMailStore.getState().openCompose({to:'x@example.com'});
  let save!:()=>void;
  stubApi({
    '/emails/send':()=>new Promise(resolve=>{save=()=>resolve(new Response(JSON.stringify({success:true,data:{emailId:'d1'}})));}),
    '/emails/d1':{success:true,data:{id:'d1',attachments:[{id:'a1',filename:'a.txt',size:1}]}},
  });
  const {container}=render(withClient(<ComposeModal onClose={()=>{}}/>));
  await editorOf();
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(['x'],'a.txt')]}});
  const remove=()=>screen.getByRole('button',{name:'Remove a.txt'}) as HTMLButtonElement;
  await waitFor(()=>expect(remove().disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  // A removal now would be undone when the save rebuilds the list from the draft's rows.
  await waitFor(()=>expect(save).toBeDefined());expect(remove().disabled).toBe(true);
  await act(async()=>save());
  await waitFor(()=>expect(remove().disabled).toBe(false));
});

it('saves into one draft, and Save, Save, Send still carries the attachment',async()=>{
  useAuthStore.setState({user:me});useMailStore.getState().openCompose({to:'x@example.com'});
  // Fake /emails/send: a save copies attachments into the draft under new IDs and releases the staged upload.
  const staged=new Set(['uploads/u/a.txt']),drafts=new Map<string,{id:string;filename:string;size:number}[]>(),statuses:number[]=[];let seq=0;
  const reply=(body:unknown,status=200)=>{statuses.push(status);return new Response(JSON.stringify(body),{status});};
  stubApi({
    '/emails/send':(init:RequestInit)=>{
      const p=JSON.parse(String(init.body)),own=p.draftId?drafts.get(p.draftId):[];
      if(!own)return reply({success:false,error:'Draft not found'},404);
      if(!p.attachmentKeys.every((k:string)=>staged.has(k))||!p.forwardAttachmentIds.every((id:string)=>own.some(a=>a.id===id)))return reply({success:false,error:'Attachment upload expired, please re-attach'},400);
      p.attachmentKeys.forEach((k:string)=>staged.delete(k));if(p.draftId)drafts.delete(p.draftId);
      const id=p.isDraft?p.draftId||'d1':'s1';
      if(p.isDraft)drafts.set(id,[...p.attachmentKeys,...p.forwardAttachmentIds].map(()=>({id:'a'+ ++seq,filename:'a.txt',size:1})));
      return reply({success:true,data:{emailId:id,deliveryStatus:p.isDraft?undefined:'sent'}});
    },
    '/emails/d1':()=>({success:true,data:{id:'d1',attachments:drafts.get('d1')}}),
  });
  const {container}=render(withClient(<ComposeModal onClose={()=>{}}/>));
  await editorOf();
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(['x'],'a.txt')]}});
  const ready=()=>waitFor(()=>expect((screen.getByRole('button',{name:'Save draft'}) as HTMLButtonElement).disabled).toBe(false));
  await ready();fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await waitFor(()=>expect(statuses).toHaveLength(1));
  await ready();fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await waitFor(()=>expect(statuses).toHaveLength(2));
  await ready();expect(screen.getAllByText('a.txt')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:/Send/}));
  await waitFor(()=>expect(statuses).toHaveLength(3));
  expect(statuses).toEqual([200,200,200]);expect(drafts.size).toBe(0);
});

it('puts a large-file link finished while minimized above the signature',async()=>{
  useAuthStore.setState({user:{...me,signatureHtml:'<p>Regards</p>'}});useMailStore.getState().openCompose();
  let finish!:()=>void;large.result=()=>new Promise(resolve=>{finish=()=>resolve({downloadUrl:'https://mail.example.com/api/files/abc'});});
  const {container}=render(withClient(<ComposeModal onClose={()=>{}}/>));
  await editorOf();
  const file=new File(['x'],'big.zip');Object.defineProperty(file,'size',{value:30*1024*1024});
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[file]}});
  fireEvent.click(screen.getByRole('button',{name:'Minimize'}));
  await act(async()=>finish());
  fireEvent.click(screen.getByRole('button',{name:'Maximize'}));
  await waitFor(async()=>expect((await editorOf()).getHTML()).toContain('big.zip'));
  const html=(await editorOf()).getHTML();
  expect(html.indexOf('big.zip')).toBeLessThan(html.indexOf('email-signature'));
});

it('does not repeat a link target the text already shows',()=>{
  const change=vi.fn();
  render(<RichTextEditor initialHtml={'<p>Mail <a href="mailto:a@b.c">a@b.c</a> or <a href="https://x.com/">https://x.com</a> or <a href="https://y.com">https://y.com/</a></p>'} onChange={change}/>);
  expect(change.mock.lastCall![0].text).toBe('Mail a@b.c or https://x.com or https://y.com/');
});

it('reopens a moved or deleted message from fresh data, not a cached folder',async()=>{
  let folder='inbox';
  stubApi({
    '/emails/e1':(init?:RequestInit)=>{if(init?.method==='DELETE')folder='trash';return {success:true,data:{id:'e1',folderId:folder,subject:'Old',sender:'a@example.com',recipientsTo:[],recipientsCc:[],receivedAt:new Date().toISOString(),attachments:[]}};},
    '/folders':{success:true,data:[{id:'trash',type:'trash',name:'Trash'},{id:'inbox',type:'inbox',name:'Inbox'}]},
  });
  function Pane(){const [open,setOpen]=useState(true);return open?<EmailView emailId="e1" onClose={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>Reopen</button>;}
  // The app's own staleTime: a cached entry is reused without a refetch for 30 s.
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,staleTime:30_000}}})}><Pane/></QueryClientProvider>);
  fireEvent.click(await screen.findByTitle('Delete'));
  fireEvent.click(await screen.findByRole('button',{name:'Reopen'}));
  expect(await screen.findByTitle('Delete forever')).toBeTruthy();
});

it('closes through onDone after Mark unread, and a reopen fetches the message again',async()=>{
  let gets=0;
  stubApi({'/emails/e1':()=>{gets++;return {success:true,data:{id:'e1',folderId:'inbox',isRead:true,subject:'Old',sender:'a@example.com',recipientsTo:[],recipientsCc:[],receivedAt:new Date().toISOString(),attachments:[]}};},'/folders':{success:true,data:[{id:'inbox',type:'inbox',name:'Inbox'}]}});
  const close=vi.fn();
  function Pane(){const [open,setOpen]=useState(true);return open?<EmailView emailId="e1" onClose={close} onDone={()=>setOpen(false)}/>:<button onClick={()=>setOpen(true)}>Reopen</button>;}
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,staleTime:30_000}}})}><Pane/></QueryClientProvider>);
  fireEvent.click(await screen.findByTitle('Mark unread'));
  fireEvent.click(await screen.findByRole('button',{name:'Reopen'}));
  await screen.findByTitle('Mark unread');
  // A fresh GET, which is what marks it read again, rather than the cached copy.
  await waitFor(()=>expect(gets).toBe(2));
  expect(close).not.toHaveBeenCalled();
});

// main.tsx renders at import time, so it loads last with the renderer stubbed out.
it('clears the previous identity on switch and reloads once on a stale chunk',async()=>{
  let tree:{props:{children:{props:{client:QueryClient}}}}|undefined;
  vi.doMock('react-dom/client',()=>({default:{createRoot:()=>({render:(el:typeof tree)=>{tree=el;}})}}));
  vi.doMock('../src/App',()=>({default:()=>null}));
  vi.doMock('../src/lib/pwa',()=>({registerServiceWorker:()=>{}}));
  useAuthStore.setState({user:me});
  await import('../src/main');
  const client=tree!.props.children.props.client;
  client.setQueryData(['folders'],{data:['mine']});
  useMailStore.setState({selectedEmailId:'e1',activeFolderId:'f1',isComposeOpen:true});
  useAuthStore.getState().setUser({...me,signatureHtml:'<p>New</p>'});
  expect(client.getQueryData(['folders'])).toBeDefined();
  useAuthStore.getState().setUser({...me,id:'other'});
  expect(client.getQueryData(['folders'])).toBeUndefined();
  expect(useMailStore.getState()).toMatchObject({selectedEmailId:null,activeFolderId:null,isComposeOpen:false});
  client.setQueryData(['folders'],{data:['other']});useMailStore.setState({selectedEmailId:'e2'});
  useAuthStore.getState().setUser(null);
  expect(client.getQueryData(['folders'])).toBeUndefined();expect(useMailStore.getState().selectedEmailId).toBeNull();

  const reload=vi.fn();vi.stubGlobal('location',{...window.location,reload});
  const fire=()=>{const e=new Event('vite:preloadError',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;};
  expect(fire()).toBe(true);expect(reload).toHaveBeenCalledTimes(1);
  expect(fire()).toBe(false);expect(reload).toHaveBeenCalledTimes(1);
});
