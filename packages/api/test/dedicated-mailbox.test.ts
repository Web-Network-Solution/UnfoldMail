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
import { emailBodyTextKey } from '../src/lib/utils';

vi.mock('cloudflare:workers',()=>({DurableObject:class { constructor(public ctx:unknown,public env:unknown) {} }}));
// Historical migration harness is test-only; the deployed class has no legacy methods.
import { MailboxDO } from '../src/durable-objects/mailbox';

function fallbackForLegacyTest(env:Env,kv:Map<string,unknown>) { return !kv.has('migration'); }
function fixture() {
  const source=testDatabase(true), target=new DatabaseSync(':memory:');
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
      if (/^\s*CREATE\b/i.test(sql)) target.exec(sql);
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
  const ctx={id:{toString:()=> 'u'},storage,blockConcurrencyWhile:(fn:()=>Promise<unknown>)=>{ready=fn();}} as unknown as DurableObjectState;
  const mailbox=new MailboxDO(ctx,env);
  const app=new Hono<{Bindings:Env;Variables:HonoVariables}>();
  app.use('*',async(c,next)=>{c.set('userId','u');c.set('userEmail','employee@example.com');c.set('userRole','super_admin');c.env=await mailboxEnv(c.env,'u');await next();});
  app.route('/emails',emailRoutes);app.route('/search',searchRoutes);app.route('/folders',folderRoutes);app.route('/calendar',calendarRoutes);
  async function migrate() {await ready;await mailbox.provision('u');}
  return {...source,target,env,mailbox,ctx,files,kv,app,ready:()=>ready,migrate,close:()=>{source.sqlite.close();target.close();}};
}


describe('dedicated-only production mailbox',()=>{
  it('receives and deduplicates incoming mail in the migrated mailbox',async()=>{
    const f=fixture();await f.migrate();
    f.files.set('inbound/test.eml','From: sender@example.com\r\nTo: employee@example.com\r\nSubject: Received in DO\r\nMessage-ID: <test@example.com>\r\nContent-Type: text/plain\r\n\r\nHello from inbound processing');
    const job={rawKey:'inbound/test.eml',from:'sender@example.com',to:'employee@example.com',rawSize:200,receivedAt:new Date().toISOString(),messageKey:'<test@example.com>'};
    await processInboundEmail(job,f.env);await processInboundEmail(job,f.env);
    expect(f.target.prepare('SELECT subject FROM emails').all()).toEqual([{subject:'Received in DO'}]);
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='emails'").all()).toHaveLength(0);f.close();
  });

  it('refuses missing routes and missing bindings instead of serving legacy mail',async()=>{
    const f=fixture();await f.ready();f.sqlite.exec("DELETE FROM mailbox_routes WHERE user_id='u'");
    await expect(mailboxEnv(f.env,'u')).rejects.toThrow(/maintenance/);
    await expect(mailboxEnv({...f.env,MAILBOXES:undefined},'u')).rejects.toThrow(/maintenance/);
    await expect(f.mailbox.provision('u')).rejects.toThrow(/empty initialization refused/);f.close();
  });
  it('provisions five folders once, persists mail only in DO and processes outgoing jobs',async()=>{
    const f=fixture();await f.migrate();await f.mailbox.provision('u');
    expect(f.target.prepare('SELECT COUNT(*) AS n FROM folders').get()).toEqual({n:5});
    expect(f.sqlite.prepare('SELECT state,provision_new FROM mailbox_routes').get()).toEqual({state:'active',provision_new:0});
    const response=await f.app.request('/emails/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:['other@example.com'],subject:'Dedicated',bodyHtml:'<p>Hello</p>',bodyText:'Hello'})},f.env);
    expect(response.status,await response.clone().text()).toBe(200);
    const {data}=await response.json() as {data:{emailId:string}};
    expect(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='emails'").all()).toHaveLength(0);
    await processOutbound({kind:'outbound',userId:'u',emailId:data.emailId},f.env);
    expect(f.target.prepare('SELECT delivery_status FROM emails').get()).toEqual({delivery_status:'sent'});
    expect((await f.app.request('/emails/'+data.emailId,{},f.env)).status).toBe(200);
    await f.mailbox.alarm();f.close();
  });
  it('retries interrupted provisioning without losing folders or duplicating reports',async()=>{
    const f=fixture();await f.ready();
    vi.mocked(f.env.EMAIL_BUCKET.put).mockRejectedValueOnce(new Error('R2 down'));
    await expect(f.mailbox.provision('u')).rejects.toThrow('R2 down');
    expect(f.sqlite.prepare('SELECT provision_new FROM mailbox_routes').get()).toEqual({provision_new:1});
    await mailboxEnv(f.env,'u');
    expect(f.target.prepare('SELECT COUNT(*) AS n FROM folders').get()).toEqual({n:5});
    expect(f.files.has('mailbox-reports/u.json')).toBe(true);f.close();
  });
  it('creates a durable provisioning marker atomically with each new account',()=>{
    const f=fixture();
    f.sqlite.exec("INSERT INTO users(id,email,display_name,password_hash) VALUES('new','new@example.com','New','h')");
    expect(f.sqlite.prepare("SELECT state,provision_new FROM mailbox_routes WHERE user_id='new'").get()).toEqual({state:'copying',provision_new:1});f.close();
  });
});


it('upgrades a populated v2 mailbox additively and survives repeated initialization without data loss',async()=>{
  const f=fixture();await f.migrate();
  const response=await f.app.request('/emails/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:['recipient@example.com'],subject:'Existing draft before AI migration',bodyHtml:'<p>Preserve this draft body</p>',bodyText:'Preserve this draft body',isDraft:true})},f.env);
  expect(response.status).toBe(200);
  // Reconstruct the exact pre-AI schema version; only the empty new table is removed.
  f.target.exec('DROP TABLE ai_candidates; DELETE FROM mailbox_schema_version WHERE version=3');
  const tables=f.target.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='mailbox_schema_version' ORDER BY name").all() as {name:string}[];
  const snapshot=()=>Object.fromEntries(tables.map(({name})=>[name,f.target.prepare(`SELECT * FROM "${name}"`).all()]));
  const before=snapshot(),files=[...f.files],state=structuredClone([...f.kv]);
  for(let i=0;i<2;i++){
    new MailboxDO(f.ctx,f.env);await f.ready();
    expect(snapshot()).toEqual(before);expect([...f.files]).toEqual(files);expect([...f.kv]).toEqual(state);
    expect(f.target.prepare('SELECT count(*) n FROM ai_candidates').get()).toEqual({n:0});
    expect(f.target.prepare('SELECT version FROM mailbox_schema_version ORDER BY version').all()).toEqual([{version:1},{version:2},{version:3},{version:4},{version:5},{version:6},{version:7}]);
  }
  f.close();
});

describe('mail API against a dedicated mailbox',()=>{
  const send=(f:ReturnType<typeof fixture>,extra:object)=>f.app.request('/emails/send',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({to:['other@example.com'],subject:'Link',bodyHtml:'<a href="https://mail.example.com/api/shared/big">file</a>',...extra})},f.env);
  it('retains a linked shared file only after the send commits, and maintenance finishes a lost retention',async()=>{
    const f=fixture();await f.migrate();
    f.sqlite.exec("INSERT INTO shared_files(id,user_id,filename,size,r2_key,lifecycle) VALUES('big','u','file.bin',1,'shared-files/big/file.bin','staged')");
    expect((await send(f,{bodyText:'x'.repeat(4*1024*1024)})).status).toBe(413);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({lifecycle:'staged'});
    expect((await send(f,{})).status).toBe(200);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({lifecycle:'retained'});
    // Simulate a failed post-commit update: the stale pins are released only once the sent link is retained.
    f.sqlite.exec("UPDATE shared_files SET lifecycle='staged'; UPDATE mailbox_shared_pins SET created_at='2000-01-01T00:00:00.000Z'");
    await maintainMailbox(await mailboxEnv(f.env,'u'),'u',4096);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({lifecycle:'retained'});
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mailbox_shared_pins').get()).toEqual({n:0});f.close();
  });
  it('keeps the purge clock for mail already in Trash and stamps it on entry',async()=>{
    const f=fixture();await f.migrate();
    f.target.exec("INSERT INTO emails(id,thread_id,folder_id,user_id,sender,r2_body_key,trashed_at) VALUES('m','t','u:inbox','u','s@example.com','body','2000-01-01T00:00:00.000Z')");
    const move=()=>f.app.request('/emails/m/move',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderId:'u:trash'})},f.env);
    const trashedAt=()=>(f.target.prepare("SELECT trashed_at FROM emails WHERE id='m'").get() as {trashed_at:string}).trashed_at;
    expect((await move()).status).toBe(200);
    expect(trashedAt()).not.toBe('2000-01-01T00:00:00.000Z');
    f.target.exec("UPDATE emails SET trashed_at='2020-01-01T00:00:00.000Z'");
    expect((await move()).status).toBe(200);
    expect((await f.app.request('/emails/m',{method:'DELETE'},f.env)).status).toBe(200);
    expect(trashedAt()).toBe('2020-01-01T00:00:00.000Z');f.close();
  });
  it('answers malformed read, star, move and folder bodies with 400',async()=>{
    const f=fixture();await f.migrate();
    f.target.exec("INSERT INTO emails(id,thread_id,folder_id,user_id,sender,r2_body_key) VALUES('m','t','u:inbox','u','s@example.com','body')");
    for(const action of ['read','star','move'])for(const body of ['{broken','null','{}']) {
      expect((await f.app.request(`/emails/m/${action}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body},f.env)).status,`${action} ${body}`).toBe(400);
    }
    for(const body of ['null','{"name":5}'])expect((await f.app.request('/folders',{method:'POST',headers:{'Content-Type':'application/json'},body},f.env)).status,body).toBe(400);
    expect((await f.app.request('/emails/m/star',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{"isStarred":true}'},f.env)).status).toBe(200);f.close();
  });
});


it('upgrades v4 cleanup schema without changing existing protocol UIDs or messages',async()=>{
  const f=fixture();await f.migrate();
  const response=await f.app.request('/emails/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:'Preserve UID',bodyText:'Existing body',isDraft:true})},f.env);
  expect(response.status).toBe(200);
  const before=f.target.prepare('SELECT * FROM protocol_messages').all();
  expect(before.length).toBe(1);
  const mail=f.target.prepare('SELECT * FROM emails').all();
  f.target.exec('DROP TABLE protocol_object_gc; DELETE FROM mailbox_schema_version WHERE version=5');
  for(let i=0;i<2;i++){
    new MailboxDO(f.ctx,f.env);await f.ready();
    expect(f.target.prepare('SELECT * FROM protocol_messages').all()).toEqual(before);
    expect(f.target.prepare('SELECT * FROM emails').all()).toEqual(mail);
    expect(f.target.prepare('SELECT count(*) n FROM protocol_object_gc').get()).toEqual({n:0});
  }
  f.close();
});
