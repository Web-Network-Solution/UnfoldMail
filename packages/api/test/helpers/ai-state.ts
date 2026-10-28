import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
export function aiState(id:string){
 const sql=new DatabaseSync(':memory:'),kv=new Map<string,unknown>();let ready=Promise.resolve(),alarm:number|null=null;
 const storage={
   get:async(k:string)=>structuredClone(kv.get(k)),put:async(k:string,v:unknown)=>{kv.set(k,structuredClone(v));},
   getAlarm:async()=>alarm,setAlarm:async(n:number)=>{alarm=n;},deleteAlarm:async()=>{alarm=null;},
   deleteAll:async()=>{kv.clear();for(const r of sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())sql.exec(`DELETE FROM "${r.name}"`);},
   transactionSync<T>(fn:()=>T):T{sql.exec('BEGIN');try{const v=fn();sql.exec('COMMIT');return v;}catch(e){sql.exec('ROLLBACK');throw e;}},
   sql:{exec(query:string,...args:SQLInputValue[]){let rows:Record<string,unknown>[]=[];if(/^\s*CREATE /i.test(query))sql.exec(query);else rows=sql.prepare(query).all(...args) as Record<string,unknown>[];return {toArray:()=>rows,one:()=>{if(rows.length!==1)throw Error('Expected one row');return rows[0];}};}}
 };
 const ctx={waitUntil:(p:Promise<unknown>)=>{void p.catch(()=>{});},id:{toString:()=>id},storage,blockConcurrencyWhile:(fn:()=>Promise<void>)=>{ready=fn();}} as unknown as DurableObjectState;
 return {ctx,sql,kv,ready:()=>ready,close:()=>sql.close()};
}
