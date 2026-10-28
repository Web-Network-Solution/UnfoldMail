import { describe,it,expect,vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { testDatabase } from './helpers/database';
import { MAILBOX_SCHEMA } from '../src/durable-objects/mailbox-schema';
import { REPORT_SCHEMA } from '../src/durable-objects/report-schema';
import { readMailboxReports } from '../src/services/mailbox-reporting';
import { publishMailboxReport } from '../src/services/mailbox-maintenance';
import { adminRoutes } from '../src/routes/admin';
import type { Env,HonoVariables } from '../src/types';

function localMailbox() {
  const db=new DatabaseSync(':memory:'); db.exec(MAILBOX_SCHEMA);
  db.exec("INSERT INTO folders(id,user_id,name,type) VALUES('in','u','Inbox','inbox'),('sent','u','Sent','sent'),('ar','u','Archive','archive'),('draft','u','Drafts','drafts')");
  const insert=(id:string,folder='in',status:string|null=null)=>db.prepare(`INSERT INTO emails(id,thread_id,folder_id,user_id,sender,r2_body_key,received_at,size,delivery_status) VALUES(?,? ,?,'u','s@example.com','body','2026-10-21T00:00:00Z',100,?)`).run(id,id,folder,status);
  return {db,insert};
}

describe('persistent activity reporting',()=>{
  it('retains received traffic across moves, deletion, and repeated schema initialization',()=>{
    const {db,insert}=localMailbox(); insert('old');db.exec(REPORT_SCHEMA);insert('new');
    db.exec("UPDATE emails SET folder_id='ar'; DELETE FROM emails");
    db.exec(REPORT_SCHEMA);
    expect(db.prepare('SELECT SUM(received) AS n FROM mailbox_activity_days').get()).toEqual({n:2});
    expect(db.prepare('SELECT SUM(n) AS n FROM mailbox_days').get()).toEqual({n:0});db.close();
  });
  it('does not count drafts or failed sends and records a successful retry exactly once',()=>{
    const {db,insert}=localMailbox();db.exec(REPORT_SCHEMA);insert('draft','draft');insert('out','sent','queued');
    db.exec("UPDATE emails SET delivery_status='failed' WHERE id='out'");
    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox_activity').get()).toEqual({n:0});
    db.exec("UPDATE emails SET delivery_status='sent' WHERE id='out'; UPDATE emails SET delivery_status='sent' WHERE id='out'; DELETE FROM emails");
    expect(db.prepare('SELECT SUM(sent) AS n FROM mailbox_activity_days').get()).toEqual({n:1});db.close();
  });
});

it('reads 500 mailboxes with two queries, zero R2 reads, and marks missing/stale data',async()=>{
  const f=testDatabase(true);
  f.sqlite.exec("DELETE FROM users");
  for(let i=0;i<500;i++) {
    f.sqlite.prepare("INSERT INTO users(id,email,display_name,password_hash) VALUES(?,?, 'User','h')").run('u'+i,`u${i}@example.com`);
    f.sqlite.prepare("UPDATE mailbox_routes SET state='active' WHERE user_id=?").run('u'+i);
    if(i===499)continue;
    f.sqlite.prepare('INSERT INTO mailbox_report_state VALUES(?,?,?)').run('u'+i,i===0?'2000-01-01T00:00:00Z':new Date().toISOString(),'2026-10-01T00:00:00Z');
    for(const day of ['2026-10-21','2025-01-01']) f.sqlite.prepare('INSERT INTO mailbox_report_days VALUES(?,?,1,100,0,1,0,100,0,0)').run('u'+i,day);
  }
  const prepare=vi.spyOn(f.db,'prepare'),get=vi.fn();
  const result=await readMailboxReports({DB:f.db,EMAIL_BUCKET:{get}} as unknown as Env,'2026-10-21','2026-10-21');
  expect(prepare).toHaveBeenCalledTimes(2);expect(get).not.toHaveBeenCalled();
  expect(result.reports).toHaveLength(499);expect(result.reports.every(r=>r.report.emails.length===1)).toBe(true);
  expect(result.freshness).toMatchObject({missingMailboxes:1,staleMailboxes:1});f.sqlite.close();
});

it('validates date ranges and returns partial reports instead of failing all users',async()=>{
  const f=testDatabase(true);f.sqlite.exec("UPDATE mailbox_routes SET state='active'");
  const app=new Hono<{Bindings:Env;Variables:HonoVariables}>();
  app.use('*',async(c,next)=>{c.set('userRole','super_admin');await next();});app.route('/admin',adminRoutes);
  const env={DB:f.db} as unknown as Env;
  for(const query of ['startDate=bad','startDate=2026-02-30','startDate=2026-10-21&endDate=2026-10-20']) {
    expect((await app.request('/admin/reports?'+query,{},env)).status).toBe(400);
  }
  const response=await app.request('/admin/reports?startDate=2026-10-01&endDate=2026-10-21',{},env);
  expect(response.status).toBe(200);
  expect((await response.json() as any).data.freshness.missingMailboxes).toBe(1);
  const plan=f.sqlite.prepare('EXPLAIN QUERY PLAN SELECT SUM(size) FROM shared_files WHERE created_at>=? AND created_at<=?').all('2026-10-01','2026-10-21');
  expect(JSON.stringify(plan)).toContain('idx_shared_files_created');f.sqlite.close();
});

it('atomically preserves the last report when publication fails and updates zero storage after deletion',async()=>{
  const f=testDatabase(true),local=localMailbox();local.db.exec(REPORT_SCHEMA);local.insert('m');
  const prepare=(sql:string)=>{
    let values: any[]=[];
    const statement={bind:(...v:any[])=>{values=v;return statement;},first:async()=>local.db.prepare(sql).get(...values),all:async()=>({results:local.db.prepare(sql).all(...values)})};return statement;
  };
  const env={DB:{prepare},CONTROL_DB:f.db,MAILBOX_USER_ID:'u',EMAIL_BUCKET:{put:vi.fn()}} as unknown as Env;
  await publishMailboxReport(env,'u',4096);
  f.sqlite.exec("CREATE TRIGGER publication_down BEFORE UPDATE ON mailbox_report_state BEGIN SELECT RAISE(ABORT,'unavailable'); END");
  local.insert('second');
  await expect(publishMailboxReport(env,'u',4096)).rejects.toThrow('unavailable');
  expect(f.sqlite.prepare('SELECT SUM(received) n FROM mailbox_report_days').get()).toEqual({n:1});
  f.sqlite.exec('DROP TRIGGER publication_down');local.db.exec('DELETE FROM emails');
  await publishMailboxReport(env,'u',4096);
  expect(f.sqlite.prepare('SELECT SUM(received) n,SUM(bytes) bytes FROM mailbox_report_days').get()).toEqual({n:2,bytes:0});
  f.sqlite.close();local.db.close();
});
