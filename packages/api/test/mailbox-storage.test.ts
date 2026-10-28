import { PROTOCOL_CLEANUP_SCHEMA } from '../src/durable-objects/protocol-schema';
import { describe,it,expect,vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { testDatabase } from './helpers/database';
import { mailboxEnv, MailboxDatabase } from '../src/services/mailbox-storage';
import { mailboxMetrics } from '../src/services/mailbox-reporting';
import { emailRoutes } from '../src/routes/emails';
import { searchRoutes } from '../src/routes/search';
import { folderRoutes } from '../src/routes/folders';
import { mailboxAdminRoutes } from '../src/routes/mailbox-admin';
import { processInboundEmail } from '../src/services/email-processor';
import { processOutbound } from '../src/services/outbox';
import { maintainMailbox } from '../src/services/mailbox-maintenance';
import { cleanupSharedUploads } from '../src/services/shared-files';
import { calendarRoutes } from '../src/routes/calendar';
import { dispatchCalendar } from '../src/services/calendar';
import { processForwarding } from '../src/services/forwarding';
import { runCentralCleanup } from '../src/services/retention';
import worker from '../src/index';
import type { Env,HonoVariables } from '../src/types';
import { cleanupDeletedMailboxes } from '../src/services/mailbox-deletion';
import { emailBodyTextKey, sessionTag } from '../src/lib/utils';

vi.mock('cloudflare:workers',()=>({DurableObject:class { constructor(public ctx:unknown,public env:unknown) {} }}));
// Historical migration harness is test-only; the deployed class has no legacy methods.
import { MailboxDO } from './legacy/mailbox';

function fallbackForLegacyTest(env:Env,kv:Map<string,unknown>) { return !kv.has('migration'); }
function fixture() {
  const source=testDatabase(), target=new DatabaseSync(':memory:');
  target.exec('PRAGMA foreign_keys=ON');
  const kv=new Map<string,unknown>(), files=new Map<string,string>();
  let alarm:number|null=null, ready:Promise<unknown>;
  const storage={
    get:async (k:string)=>structuredClone(kv.get(k)),put:async(k:string,v:unknown)=>{kv.set(k,structuredClone(v));},delete:async(k:string)=>kv.delete(k),
    getAlarm:async()=>alarm,setAlarm:async(n:number)=>{alarm=n;},deleteAlarm:async()=>{alarm=null;},deleteAll:async()=>{
      kv.clear();target.exec('PRAGMA foreign_keys=OFF');
      const tables=target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY sql LIKE 'CREATE VIRTUAL TABLE%' DESC").all() as {name:string}[];
      for(const table of tables)target.exec(`DROP TABLE IF EXISTS "${table.name}"`);
      target.exec('PRAGMA foreign_keys=ON');
    },
    transactionSync<T>(fn:()=>T):T {target.exec('BEGIN');try {const r=fn();target.exec('COMMIT');return r;}catch(e){target.exec('ROLLBACK');throw e;}},
    sql:{databaseSize:4096,exec(sql:string,...values:SQLInputValue[]) {
      let rows:Record<string,unknown>[]=[];
      if (sql.includes('CREATE VIRTUAL TABLE')) target.exec(sql);
      else rows=target.prepare(sql).all(...values) as Record<string,unknown>[];
      return {toArray:()=>rows,one:()=>{if(rows.length!==1)throw new Error('Expected one row');return rows[0];}};
    }},
  };
  const namespace={idFromName:(id:string)=>({toString:()=>id}),get:()=>mailbox};
  const env={DB:source.db,MAILBOXES:namespace,EMAIL_DOMAIN:'example.com',APP_URL:'https://mail.example.com',
    EMAIL_BUCKET:{put:vi.fn(async(k:string,v:string)=>{files.set(k,v);}),get:vi.fn(async(k:string)=>files.has(k)?{size:files.get(k)!.length,text:async()=>files.get(k),json:async()=>JSON.parse(files.get(k)!),arrayBuffer:async()=>new TextEncoder().encode(files.get(k)!).buffer}:null),delete:vi.fn(async(keys:string|string[])=>{for(const key of Array.isArray(keys)?keys:[keys])files.delete(key);}),list:async()=>({objects:[],truncated:false})},
    OUTBOUND_QUEUE:{send:vi.fn(async()=>{}),sendBatch:vi.fn(async()=>{})},
    SEND_EMAIL:{send:vi.fn(async()=>({messageId:'test-provider-id'}))},
    WEBSOCKET_HUB:{idFromName:()=> 'u',get:()=>({fetch:async()=>new Response('{}')})},
  } as unknown as Env;
  const mailbox=new MailboxDO({id:{toString:()=> 'u'},storage,blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{ready=fn();}} as unknown as DurableObjectState,env);
  const app=new Hono<{Bindings:Env;Variables:HonoVariables}>();
  app.use('*',async(c,next)=>{c.set('userId','u');c.set('userEmail','employee@example.com');c.set('userRole','super_admin');c.env=fallbackForLegacyTest(c.env,kv) ? {...c.env,MAILBOX_USER_ID:'u'} : await mailboxEnv(c.env,'u');await next();});
  app.route('/emails',emailRoutes);app.route('/search',searchRoutes);app.route('/folders',folderRoutes);app.route('/calendar',calendarRoutes);
  async function migrate() {await ready;await mailbox.begin('u');let state;do{state=await mailbox.copyStep('u');}while(state.phase==='copying');await mailbox.activate('u');}
  return {...source,target,env,mailbox,files,kv,app,ready:()=>ready,migrate,close:()=>{source.sqlite.close();target.close();}};
}

describe('per-employee mailbox migration',()=>{
  it('applies the registry migration to a populated legacy database without changing existing mail',()=>{
    const db=new DatabaseSync(':memory:');const dir=join(__dirname,'../migrations');
    for(const file of readdirSync(dir).sort().filter(f=>f<'0019'))db.exec(readFileSync(join(dir,file),'utf8'));
    db.exec("INSERT INTO users(id,email,display_name,password_hash) VALUES('legacy','legacy@example.com','Legacy','hash'); INSERT INTO folders(id,user_id,name,type) VALUES('legacy-in','legacy','Inbox','inbox'); INSERT INTO emails(id,thread_id,folder_id,user_id,sender,r2_body_key) VALUES('legacy-mail','legacy-thread','legacy-in','legacy','sender@example.com','existing-body')");
    const before=db.prepare('SELECT * FROM emails').all();
    db.exec(readFileSync(join(dir,'0019_mailbox_storage.sql'),'utf8'));
    expect(db.prepare('SELECT * FROM emails').all()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec("UPDATE emails SET is_read=1 WHERE id='legacy-mail'");db.close();
  });
  it('copies multiple pages, verifies values and indexes, routes mail and safely prunes only legacy metadata',async()=>{
    const f=fixture();
    for(let i=0;i<85;i++)f.email(`mail-${i}`);
    await f.migrate();
    expect(f.target.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({n:85});
    expect(f.target.prepare('SELECT SUM(n) AS n FROM mailbox_days').get()).toEqual({n:85});
    expect(f.files.size).toBeGreaterThan(8);
    await expect(f.db.prepare("UPDATE emails SET is_read=1 WHERE id='mail-0'").run()).rejects.toThrow(/Mailbox maintenance/);
    const scoped=await mailboxEnv(f.env,'u');
    await scoped.DB.prepare("UPDATE emails SET is_read=1 WHERE id='mail-0'").run();
    expect(f.sqlite.prepare("SELECT is_read FROM emails WHERE id='mail-0'").get()).toEqual({is_read:0});
    expect(f.target.prepare("SELECT is_read FROM emails WHERE id='mail-0'").get()).toEqual({is_read:1});
    expect((await f.app.request('/search?q=searchable',{},f.env)).status).toBe(200);
    expect((await f.app.request('/folders',{},f.env)).status).toBe(200);
    await expect(f.mailbox.abort('u')).rejects.toThrow(/reverse data migration/);
    let result;do{result=await f.mailbox.pruneLegacy('u');}while(result.remaining);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({n:0});
    expect(f.target.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({n:85});
    expect(f.env.EMAIL_BUCKET.delete).not.toHaveBeenCalled();f.close();
  });
  it('blocks mailbox writes while copying, rejects wrong identity and permits preactivation abort',async()=>{
    const f=fixture();f.email('original');await f.ready();await f.mailbox.begin('u');
    await expect(mailboxEnv(f.env,'u')).rejects.toThrow(/maintenance/);
    await expect(f.mailbox.status('another-user')).rejects.toThrow(/identity/);
    await f.mailbox.copyStep('u');await f.mailbox.abort('u');
    await f.db.prepare("UPDATE emails SET is_read=1 WHERE id='original'").run();
    expect(f.target.prepare('SELECT COUNT(*) AS n FROM emails').get()).toEqual({n:0});
    await f.migrate();expect(f.target.prepare("SELECT is_read FROM emails WHERE id='original'").get()).toEqual({is_read:1});f.close();
  });
  it('refuses migration while a delivery is in flight',async()=>{
    const f=fixture();f.email('sending');
    f.sqlite.exec("INSERT INTO outbound_jobs(email_id,user_id,payload,status,next_attempt_at,updated_at) VALUES('sending','u','{}','sending','2020','2020')");
    await f.ready();await expect(f.mailbox.begin('u')).rejects.toThrow(/in-progress delivery/);
    expect(f.sqlite.prepare('SELECT * FROM mailbox_routes').all()).toHaveLength(0);f.close();
  });
  it('saves new mail and its job atomically in the DO while protecting central shared files',async()=>{
    const f=fixture();await f.migrate();
    f.sqlite.exec("INSERT INTO shared_files(id,user_id,filename,mime_type,size,r2_key,lifecycle) VALUES('large','u','large.bin','application/octet-stream',123,'shared/large','staged')");
    const response=await f.app.request('/emails/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:['other@example.com'],subject:'Hello',bodyHtml:'https://mail.example.com/api/shared/large',bodyText:'Hello',requestId:'0123456789abcdef'})},f.env);
    expect(response.status,await response.clone().text()).toBe(200);
    expect(f.sqlite.prepare('SELECT * FROM emails').all()).toHaveLength(0);
    expect(f.target.prepare('SELECT * FROM emails').all()).toHaveLength(1);
    expect(f.target.prepare('SELECT * FROM outbound_jobs').all()).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({lifecycle:'retained'});
    expect(f.sqlite.prepare('SELECT * FROM mailbox_shared_pins').all()).toHaveLength(1);
    const scoped=await mailboxEnv(f.env,'u');
    await expect(scoped.DB.batch([scoped.DB.prepare("UPDATE emails SET subject='changed'"),scoped.DB.prepare("INSERT INTO folders(id,user_id,name,type) VALUES('in','u','Duplicate','inbox')")])).rejects.toThrow();
    expect(f.target.prepare('SELECT subject FROM emails').get()).toEqual({subject:'Hello'});
    await expect(scoped.DB.batch([scoped.DB.prepare('SELECT * FROM emails'),scoped.DB.prepare('SELECT * FROM users')])).rejects.toThrow(/Cross-store transaction/);
    expect(()=>scoped.DB.prepare('SELECT * FROM emails JOIN users ON users.id=emails.user_id')).toThrow(/Cross-store/);f.close();
  });
  it('does not double-count legacy copies in administrative queries',async()=>{
    const f=fixture();f.email('one');await f.migrate();
    expect((await mailboxMetrics(f.env))[0].emails).toBe(1);f.close();
  });
  it('replays an interrupted copy page without double-counting or duplicating data',async()=>{
    const f=fixture();for(let i=0;i<45;i++)f.email(`m-${i}`);await f.ready();await f.mailbox.begin('u');
    await f.mailbox.copyStep('u');
    const before=structuredClone(f.kv.get('migration'));
    await f.mailbox.copyStep('u');f.kv.set('migration',before);
    let state;do{state=await f.mailbox.copyStep('u');}while(state.phase==='copying');
    expect(f.target.prepare('SELECT SUM(n) AS n FROM mailbox_days').get()).toEqual({n:45});
    expect((await f.mailbox.copyStep('u')).phase).toBe('verified');f.close();
  });
  it('receives and deduplicates incoming mail in the migrated mailbox',async()=>{
    const f=fixture();await f.migrate();
    f.files.set('inbound/test.eml','From: sender@example.com\r\nTo: employee@example.com\r\nSubject: Received in DO\r\nMessage-ID: <test@example.com>\r\nContent-Type: text/plain\r\n\r\nHello from inbound processing');
    const job={rawKey:'inbound/test.eml',from:'sender@example.com',to:'employee@example.com',rawSize:200,receivedAt:new Date().toISOString(),messageKey:'<test@example.com>'};
    await processInboundEmail(job,f.env);await processInboundEmail(job,f.env);
    expect(f.target.prepare('SELECT subject FROM emails').all()).toEqual([{subject:'Received in DO'}]);
    expect(f.sqlite.prepare('SELECT * FROM emails').all()).toHaveLength(0);f.close();
  });
  it('delivers from a migrated outbox once and publishes cached admin summaries',async()=>{
    const f=fixture();await f.migrate();
    const response=await f.app.request('/emails/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:['other@example.com'],subject:'Send once',bodyText:'Hello',bodyHtml:'Hello'})},f.env);
    expect(response.status).toBe(200);
    const body=await response.json() as {data:{emailId:string}};
    await processOutbound({kind:'outbound',userId:'u',emailId:body.data.emailId},f.env);
    await processOutbound({kind:'outbound',userId:'u',emailId:body.data.emailId},f.env);
    expect(f.env.SEND_EMAIL.send).toHaveBeenCalledTimes(1);
    expect(f.target.prepare('SELECT delivery_status FROM emails').get()).toEqual({delivery_status:'sent'});
    // Historical migration fixture predates the new protocol cleanup table.
    f.target.exec(PROTOCOL_CLEANUP_SCHEMA);
    await maintainMailbox(await mailboxEnv(f.env,'u'),'u',4096);
    expect(f.sqlite.prepare('SELECT emails,sent,database_bytes FROM mailbox_metrics').get()).toEqual({emails:1,sent:1,database_bytes:4096});
    expect(f.files.has('mailbox-reports/u.json')).toBe(true);f.close();
  });
  it('keeps shared draft files protected through migration and legacy pruning',async()=>{
    const f=fixture();f.email('draft','drafts');
    f.sqlite.exec("INSERT INTO shared_files(id,user_id,filename,mime_type,size,r2_key,lifecycle,created_at) VALUES('large','u','large.bin','application/octet-stream',123,'shared/large','staged','2000-01-01T00:00:00.000Z'); INSERT INTO email_shared_files(email_id,share_id) VALUES('draft','large')");
    await f.migrate();await f.mailbox.pruneLegacy('u');await cleanupSharedUploads(f.env);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({lifecycle:'staged'});
    expect(f.target.prepare('SELECT * FROM email_shared_files').all()).toHaveLength(1);f.close();
  });
  it('keeps calendar events central and invitation sent copies in the mailbox',async()=>{
    const f=fixture();await f.migrate();
    const response=await f.app.request('/calendar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Planning',description:'Review',location:'Office',start:'2030-03-09T14:00:00.000Z',end:'2030-03-09T15:00:00.000Z',timezone:'UTC',allDay:false,recurrence:'',attendees:['guest@example.com'],reminderMinutes:15})},f.env);
    expect(response.status,await response.clone().text()).toBe(201);
    await dispatchCalendar(f.env);await dispatchCalendar(f.env);
    expect(f.env.SEND_EMAIL.send).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT * FROM calendar_events').all()).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT * FROM emails').all()).toHaveLength(0);
    expect(f.target.prepare('SELECT * FROM emails').all()).toHaveLength(1);
    expect(f.target.prepare('SELECT * FROM attachments').all()).toHaveLength(1);
    expect(f.sqlite.prepare('SELECT sent_copy_saved FROM calendar_deliveries').get()).toEqual({sent_copy_saved:1});f.close();
  });
  it('applies forwarding rules and sends their durable job from the migrated mailbox',async()=>{
    const f=fixture();await f.migrate();
    f.sqlite.prepare('INSERT INTO forwarding_configs(user_id,revision,config,updated_at) VALUES(?,1,?,?)').run('u',JSON.stringify({revision:1,destinations:['guest@example.com'],forwardAll:'guest@example.com',rules:[]}),new Date().toISOString());
    f.files.set('inbound/forward.eml','From: sender@example.com\r\nTo: employee@example.com\r\nSubject: Forward from DO\r\nMessage-ID: <forward@example.com>\r\nContent-Type: text/plain\r\n\r\nHello');
    await processInboundEmail({rawKey:'inbound/forward.eml',from:'sender@example.com',to:'employee@example.com',rawSize:150,receivedAt:new Date().toISOString()},f.env);
    const row=f.target.prepare('SELECT id FROM forwarding_jobs').get() as {id:string};
    expect(row).toBeTruthy();
    await processForwarding({kind:'forwarding',id:row.id,userId:'u'},f.env);
    await processForwarding({kind:'forwarding',id:row.id,userId:'u'},f.env);
    expect(f.env.SEND_EMAIL.send).toHaveBeenCalledTimes(1);
    expect(f.target.prepare('SELECT status FROM forwarding_jobs').get()).toEqual({status:'sent'});
    expect(f.sqlite.prepare('SELECT * FROM forwarding_jobs').all()).toHaveLength(0);f.close();
  });
  it('keeps migration controls restricted to super admins',async()=>{
    const f=fixture();const app=new Hono<{Bindings:Env;Variables:HonoVariables}>();
    app.use('*',async(c,next)=>{c.set('userRole','admin');await next();});app.route('/mailboxes',mailboxAdminRoutes);
    expect((await app.request('/mailboxes/u/begin',{method:'POST'},f.env)).status).toBe(403);await f.ready();f.close();
  });
  it('removes legacy migration actions from the full router',async()=>{
    const f=fixture();await f.ready();
    f.sqlite.exec(`UPDATE users SET role='super_admin' WHERE id='u'; INSERT INTO sessions(token,user_id,expires_at) VALUES('${await sessionTag('test-session')}','u','2099-01-01T00:00:00.000Z')`);
    await f.mailbox.begin('u');
    const request=new Request('https://mail.example.com/api/admin/mailboxes/u/copy',{method:'POST',headers:{Cookie:'session_token=test-session',Origin:'https://mail.example.com','Content-Type':'application/json'},body:'{}'});
    const response=await worker.fetch(request,f.env,{} as ExecutionContext);
    expect(response.status,await response.clone().text()).toBe(404);f.close();
  });
  it('preserves pending raw mail for existing employees even during extended maintenance',async()=>{
    const f=fixture();await f.ready();await f.mailbox.begin('u');
    const raw=(key:string,email:string):R2Object=>({key,uploaded:new Date('2000-01-01'),customMetadata:{envelopeTo:email},
      version:'test',size:1,etag:'test',httpEtag:'"test"',checksums:{toJSON:()=>({})},storageClass:'Standard',writeHttpMetadata:()=>{}});
    vi.spyOn(f.env.EMAIL_BUCKET,'list').mockImplementation(async options=>({objects:options?.prefix==='inbound/'?[
      raw('inbound/pending','employee@example.com'),raw('inbound/unknown','unknown@example.com'),
    ]:[],truncated:false,delimitedPrefixes:[]}));
    await runCentralCleanup(f.env);
    expect(f.env.EMAIL_BUCKET.delete).toHaveBeenCalledWith(['inbound/unknown']);
    expect(f.env.EMAIL_BUCKET.delete).not.toHaveBeenCalledWith(expect.arrayContaining(['inbound/pending']));f.close();
  });
  it('removes an active account through the admin API while preserving recipient-facing shared files',async()=>{
    const f=fixture();f.email('legacy-copy');await f.migrate();
    f.sqlite.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES('root','root@example.com','Root','hash','super_admin'); INSERT INTO sessions(token,user_id,expires_at) VALUES('${await sessionTag('root-session')}','root','2099-01-01T00:00:00.000Z'); INSERT INTO shared_files(id,user_id,filename,mime_type,size,r2_key,lifecycle) VALUES('retained','u','file','text/plain',3,'shared/file','retained')`);
    const response=await worker.fetch(new Request('https://mail.example.com/api/admin/users/u',{method:'DELETE',headers:{Cookie:'session_token=root-session',Origin:'https://mail.example.com'}}),f.env,{} as ExecutionContext);
    expect(response.status,await response.clone().text()).toBe(200);
    expect(f.sqlite.prepare("SELECT user_id,lifecycle FROM shared_files WHERE id='retained'").get()).toEqual({user_id:null,lifecycle:'retained'});
    await expect(f.mailbox.execute('u',[{sql:'SELECT * FROM emails',values:[]}])).rejects.toThrow(/does not exist/);f.close();
  });
});

describe('mailbox failure recovery regressions',()=>{
  const send=(f:ReturnType<typeof fixture>,body:Record<string,unknown>)=>f.app.request('/emails/send',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  },f.env);
  it('preserves a committed send after a lost RPC response even without requestId',async()=>{
    const f=fixture();await f.migrate();
    const execute=f.mailbox.execute.bind(f.mailbox);let injected=false;
    vi.spyOn(f.mailbox,'execute').mockImplementation(async(user,queries)=>{
      const result=await execute(user,queries);
      if(!injected&&queries.some(q=>q.sql.includes('INSERT INTO outbound_jobs'))){injected=true;throw new Error('Response lost after commit');}
      return result;
    });
    const response=await send(f,{to:['guest@example.com'],subject:'Committed',bodyHtml:'Important',bodyText:'Important'});
    expect(response.status).toBe(200);
    const row=f.target.prepare('SELECT id,r2_body_key FROM emails').get() as {id:string;r2_body_key:string};
    expect(f.files.get(row.r2_body_key)).toBe('Important');
    await processOutbound({kind:'outbound',userId:'u',emailId:row.id},f.env);
    expect(f.env.SEND_EMAIL.send).toHaveBeenCalledTimes(1);f.close();
  });
  it('preserves content when both the commit response and verification read fail',async()=>{
    const f=fixture();await f.migrate();const execute=f.mailbox.execute.bind(f.mailbox);let committed=false;
    vi.spyOn(f.mailbox,'execute').mockImplementation(async(user,queries)=>{
      if(committed)throw new Error('Storage temporarily unreachable');
      const result=await execute(user,queries);
      if(queries.some(q=>q.sql.includes('INSERT INTO outbound_jobs'))){committed=true;throw new Error('Response lost');}
      return result;
    });
    expect((await send(f,{to:['guest@example.com'],bodyHtml:'Keep',bodyText:'Keep'})).status).toBe(500);
    const row=f.target.prepare('SELECT r2_body_key FROM emails').get() as {r2_body_key:string};
    expect(f.files.get(row.r2_body_key)).toBe('Keep');f.close();
  });
  it('keeps the original draft body when migration freezes an in-flight save',async()=>{
    const f=fixture();await f.ready();f.email('draft','drafts');
    f.sqlite.exec("UPDATE emails SET r2_body_key='emails/u/draft/body.html' WHERE id='draft'");
    f.files.set('emails/u/draft/body.html','Original');f.files.set('emails/u/draft/body.txt','Original text');
    const put=vi.mocked(f.env.EMAIL_BUCKET.put).getMockImplementation()!;let frozen=false;
    vi.spyOn(f.env.EMAIL_BUCKET,'put').mockImplementation(async(...args)=>{
      if(!frozen&&args[0].includes('/revisions/')){frozen=true;await f.mailbox.begin('u');}
      return put(...args);
    });
    expect((await send(f,{isDraft:true,draftId:'draft',subject:'Rejected',bodyHtml:'Rejected body',bodyText:'Rejected text'})).status).toBe(500);
    expect(f.files.get('emails/u/draft/body.html')).toBe('Original');
    expect(f.files.get('emails/u/draft/body.txt')).toBe('Original text');
    expect(f.sqlite.prepare("SELECT subject FROM emails WHERE id='draft'").get()).toEqual({subject:'Test'});
    let state;do{state=await f.mailbox.copyStep('u');}while(state.phase==='copying');await f.mailbox.activate('u');
    const read=await f.app.request('/emails/draft',{},f.env);
    expect((await read.json() as {data:{bodyHtml:string}}).data.bodyHtml).toBe('Original');f.close();
  });
  it.each([false,true])('rejects concurrent draft overwrites atomically (migrated=%s)',async migrated=>{
    const f=fixture();if(migrated)await f.migrate();else await f.ready();
    const first=await send(f,{isDraft:true,subject:'Initial',bodyHtml:'Initial',bodyText:'Initial text'});
    const id=(await first.json() as {data:{emailId:string}}).data.emailId;
    const put=vi.mocked(f.env.EMAIL_BUCKET.put).getMockImplementation()!;let raced=false;
    vi.spyOn(f.env.EMAIL_BUCKET,'put').mockImplementation(async(...args)=>{
      if(!raced&&args[0].endsWith('/body.html')){
        raced=true;
        expect((await send(f,{isDraft:true,draftId:id,subject:'Winner',bodyHtml:'Winner',bodyText:'Winner text'})).status).toBe(200);
      }
      return put(...args);
    });
    expect((await send(f,{isDraft:true,draftId:id,subject:'Loser',bodyHtml:'Loser',bodyText:'Loser text'})).status).toBe(409);
    const db=migrated?f.target:f.sqlite;
    const row=db.prepare('SELECT subject,r2_body_key FROM emails WHERE id=?').get(id) as {subject:string;r2_body_key:string};
    expect(row.subject).toBe('Winner');expect(f.files.get(row.r2_body_key)).toBe('Winner');
    expect(f.files.get(emailBodyTextKey('u',id,row.r2_body_key))).toBe('Winner text');
    expect(db.prepare('SELECT subject FROM emails_fts').all()).toEqual([{subject:'Winner'}]);
    expect(db.prepare('SELECT * FROM mailbox_write_guard').all()).toEqual([]);
    const read=await f.app.request(`/emails/${id}`,{},f.env);
    expect((await read.json() as {data:{bodyText:string}}).data.bodyText).toBe('Winner text');f.close();
  });
  it('publishes initial reports before activation and retries failed publication safely',async()=>{
    const f=fixture();f.email('one');await f.ready();await f.mailbox.begin('u');
    let state;do{state=await f.mailbox.copyStep('u');}while(state.phase==='copying');
    vi.mocked(f.env.EMAIL_BUCKET.put).mockRejectedValueOnce(new Error('R2 unavailable'));
    await expect(f.mailbox.activate('u')).rejects.toThrow('R2 unavailable');
    expect(f.sqlite.prepare('SELECT state FROM mailbox_routes').get()).toEqual({state:'verified'});
    expect((await f.mailbox.status('u')).migration?.phase).toBe('verified');
    await f.mailbox.activate('u');
    f.sqlite.exec(`UPDATE users SET role='super_admin' WHERE id='u'; INSERT INTO sessions(token,user_id,expires_at) VALUES('${await sessionTag('report-session')}','u','2099-01-01T00:00:00.000Z')`);
    const response=await worker.fetch(new Request('https://mail.example.com/api/admin/reports',{headers:{Cookie:'session_token=report-session'}}),f.env,{} as ExecutionContext);
    expect(response.status,await response.clone().text()).toBe(200);
    expect(f.files.has('mailbox-reports/u.json')).toBe(true);f.close();
  });
  it.each(['copying','verified','active'])('fully removes deleted mailbox data in phase %s',async phase=>{
    const f=fixture();f.email('private');await f.ready();await f.mailbox.begin('u');
    await f.mailbox.copyStep('u');await f.mailbox.copyStep('u');
    if(phase!=='copying'){let state;do{state=await f.mailbox.copyStep('u');}while(state.phase==='copying');}
    if(phase==='active')await f.mailbox.activate('u');
    f.sqlite.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES('root','root@example.com','Root','hash','super_admin'); INSERT INTO sessions(token,user_id,expires_at) VALUES('${await sessionTag('root-session')}','root','2099-01-01T00:00:00.000Z')`);
    const response=await worker.fetch(new Request('https://mail.example.com/api/admin/users/u',{method:'DELETE',headers:{Cookie:'session_token=root-session',Origin:'https://mail.example.com'}}),f.env,{} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.target.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    expect(f.kv.has('migration')).toBe(false);
    expect(f.sqlite.prepare('SELECT * FROM mailbox_deletions').all()).toEqual([]);f.close();
  });
  it('retries DO deletion from a durable tombstone after the account is gone',async()=>{
    const f=fixture();await f.migrate();
    const destroy=vi.spyOn(f.mailbox,'destroyDeletedAccount').mockRejectedValueOnce(new Error('DO unavailable'));
    f.sqlite.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES('root','root@example.com','Root','hash','super_admin'); INSERT INTO sessions(token,user_id,expires_at) VALUES('${await sessionTag('root-session')}','root','2099-01-01T00:00:00.000Z')`);
    const response=await worker.fetch(new Request('https://mail.example.com/api/admin/users/u',{method:'DELETE',headers:{Cookie:'session_token=root-session',Origin:'https://mail.example.com'}}),f.env,{} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(f.sqlite.prepare('SELECT user_id FROM mailbox_deletions').get()).toEqual({user_id:'u'});
    for(let i=0;i<4;i++)await cleanupDeletedMailboxes(f.env);
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(f.sqlite.prepare('SELECT * FROM mailbox_deletions').all()).toEqual([]);
    expect(f.kv.has('migration')).toBe(false);f.close();
  });
  it('refuses internal deletion for an existing account or wrong mailbox identity',async()=>{
    const f=fixture();await f.migrate();
    await expect(f.mailbox.destroyDeletedAccount('u')).rejects.toThrow('existing account');
    await expect(f.mailbox.destroyDeletedAccount('wrong')).rejects.toThrow('identity');f.close();
  });
});
