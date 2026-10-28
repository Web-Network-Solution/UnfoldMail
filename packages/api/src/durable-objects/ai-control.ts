import { DurableObject } from 'cloudflare:workers';
import { AI_FEATURES, DEFAULT_AI_CONFIG, type AIConfig, type AIFeature, type AISettingsView } from '@email-service/shared';
import type { Env } from '../types';
import { aiErrorInfo, AIError, completion, decryptCredential, encryptCredential, validateProviderUrl, type ModelMessage, type ModelTool } from '../services/ai-provider';

export function validateAIConfig(value:unknown):AIConfig {
  if(!value||typeof value!=='object')throw new AIError('Invalid AI settings');
  const c={...DEFAULT_AI_CONFIG,...value} as AIConfig;
  if(Object.keys(c).some(k=>!(k in DEFAULT_AI_CONFIG)))throw new AIError('Unknown AI setting');
  if(typeof c.enabled!=='boolean'||!['all','selected'].includes(c.audience)||!Array.isArray(c.employees)||c.employees.length>5000||c.employees.some(v=>typeof v!=='string'||v.length>64))throw new AIError('Invalid employee access settings');
  if(!c.features||AI_FEATURES.some(k=>typeof c.features[k]!=='boolean')||Object.keys(c.features).some(k=>!AI_FEATURES.includes(k as AIFeature)))throw new AIError('Invalid feature permissions');
  validateProviderUrl(c.baseUrl);
  if(typeof c.screenIncoming!=='boolean'||typeof c.cleanDrafts!=='boolean')throw new AIError('Invalid review settings');
  for(const [key,min,max]of [['reviewTimeoutSeconds',5,90],['reviewMaxOutputTokens',128,8192],['revision',0,1e9],['maxSteps',1,10],['maxOutputTokens',128,8192],['maxContextChars',2000,60000],['maxEmails',1,25],['historyMessages',0,40],['timeoutSeconds',5,90],['retries',0,2],['requestsPerMinute',1,120],['concurrentRequests',1,50],['userDailyTokens',1000,1e9],['userMonthlyTokens',1000,1e10],['orgDailyTokens',1000,1e10],['orgMonthlyTokens',1000,1e11],['retentionDays',1,365],['auditRetentionDays',7,365],['autoDraftsPerDay',1,100]] as const){if(!Number.isSafeInteger(c[key])||c[key]<min||c[key]>max)throw new AIError(`${key} must be between ${min} and ${max}`);}
  for(const key of ['monthlyBudgetUsd','inputPrice','outputPrice','reviewInputPrice','reviewOutputPrice'] as const)if(!Number.isFinite(c[key])||c[key]<0||c[key]>1000000)throw new AIError(`Invalid ${key}`);
  for(const [key,max]of [['screeningModel',200],['cleanupModel',200],['model',200],['instructions',6000],['language',100],['tone',200]]as const)if(typeof c[key]!=='string'||c[key].length>max)throw new AIError(`Invalid ${key}`);
  if(c.enabled&&!c.model.trim())throw new AIError('Choose a model');
  return structuredClone(c);
}
type Stored={config:AIConfig;encryptedKey:string;keyHint:string;tested:boolean;capabilities:AISettingsView['capabilities']};
export class AIControlDO extends DurableObject<Env> {
  private pending:Promise<unknown>=Promise.resolve();
  private serial<T>(fn:()=>Promise<T>){const p=this.pending.then(fn,fn);this.pending=p.catch(()=>undefined);return p;}
  constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,model TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,cost REAL NOT NULL,status TEXT NOT NULL,input_price REAL NOT NULL DEFAULT 0,output_price REAL NOT NULL DEFAULT 0,latency INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS ai_usage_date ON ai_usage(created);
      CREATE INDEX IF NOT EXISTS ai_usage_user ON ai_usage(user_id,created);
      CREATE TABLE IF NOT EXISTS ai_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,created INTEGER NOT NULL,details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_versions(id TEXT PRIMARY KEY,created INTEGER NOT NULL,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_auto(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,created INTEGER NOT NULL);`);
  });}
  private async state():Promise<Stored>{const s=await this.ctx.storage.get<Stored>('settings');if(s)return {...s,config:{...DEFAULT_AI_CONFIG,...s.config}};return {config:structuredClone(DEFAULT_AI_CONFIG),encryptedKey:'',keyHint:'',tested:false,capabilities:null};}
  private async admin(actor:string){const user=await this.env.DB.prepare("SELECT id FROM users WHERE id=? AND role='super_admin'").bind(actor).first();if(!user)throw new AIError('Super-admin access required');}
  private log(actor:string,action:string,details:unknown={}){this.ctx.storage.sql.exec('INSERT INTO ai_audit VALUES(?,?,?,?,?)',crypto.randomUUID(),actor,action,Date.now(),JSON.stringify(details));}
  async view(actor:string){await this.admin(actor);const s=await this.state();return {config:s.config,hasKey:!!s.encryptedKey,keyHint:s.keyHint,tested:s.tested,capabilities:s.capabilities,encryptionReady:!!this.env.AI_ENCRYPTION_KEY};}
  async policy(userId:string,feature?:AIFeature){const user=await this.env.DB.prepare('SELECT id,must_reset_password FROM users WHERE id=?').bind(userId).first<{id:string;must_reset_password:number}>();
    if(!user||user.must_reset_password)throw new AIError('Account is unavailable');
    const s=await this.state(),c=s.config;
    if(!c.enabled||!s.tested||!s.encryptedKey)throw new AIError('AI is disabled or the provider has not passed its connection test');
    if(c.audience==='selected'&&!c.employees.includes(userId))throw new AIError('AI is not enabled for your account');
    if(feature&&!c.features[feature])throw new AIError('This AI feature is disabled by your administrator');return c;
  }
  async save(actor:string,value:unknown,key?:string,removeKey=false){return this.serial(async()=>{await this.admin(actor);const s=await this.state(),c=validateAIConfig(value);
    if(c.revision!==s.config.revision)throw new AIError('Settings changed. Reload before saving.');
    if(key!==undefined&&(typeof key!=='string'||key.length<8||key.length>2048))throw new AIError('API key must be 8–2048 characters');
    if(removeKey&&key)throw new AIError('Choose either replace or remove key');
    if(key){if(!this.env.AI_ENCRYPTION_KEY)throw new AIError('Set the AI_ENCRYPTION_KEY Worker secret first');s.encryptedKey=await encryptCredential(this.env.AI_ENCRYPTION_KEY,key);s.keyHint='••••'+key.slice(-4);}
    if(removeKey){s.encryptedKey='';s.keyHint='';}
    if(key||removeKey||c.baseUrl!==s.config.baseUrl||c.model!==s.config.model){s.tested=false;s.capabilities=null;}
    if(c.enabled&&(!s.tested||!s.encryptedKey))throw new AIError('Save provider settings with AI disabled, then test the connection before enabling AI');
    this.ctx.storage.sql.exec('INSERT INTO ai_versions VALUES(?,?,?)',crypto.randomUUID(),Date.now(),JSON.stringify(s.config));
    c.revision++;s.config=c;await this.ctx.storage.put('settings',s);this.log(actor,'settings_updated',{revision:c.revision,keyChanged:!!key||removeKey});
    // Never postpone pending housekeeping: frequent saves would otherwise defer it indefinitely.
    const at=Date.now()+86400000,existing=await this.ctx.storage.getAlarm();if(existing===null||existing>at)await this.ctx.storage.setAlarm(at);return this.view(actor);
  });}
  async stop(actor:string){return this.serial(async()=>{await this.admin(actor);const s=await this.state();s.config.enabled=false;s.config.revision++;await this.ctx.storage.put('settings',s);this.log(actor,'emergency_stop');return this.view(actor);});}
  async rollback(actor:string,id:string){await this.admin(actor);const row=this.ctx.storage.sql.exec<{config:string}>('SELECT config FROM ai_versions WHERE id=?',id).toArray()[0];if(!row)throw new AIError('Version not found');const s=await this.state();const config={...DEFAULT_AI_CONFIG,...JSON.parse(row.config)} as AIConfig;config.revision=s.config.revision;config.enabled=false;return this.save(actor,config);}
  async test(actor:string){await this.admin(actor);const s=await this.state();if(!s.encryptedKey||!this.env.AI_ENCRYPTION_KEY||!s.config.model)throw new AIError('Save a provider, model and API key first');
    const last=await this.ctx.storage.get<number>('lastTest')||0;if(Date.now()-last<10000)throw new AIError('Wait ten seconds between connection tests');await this.ctx.storage.put('lastTest',Date.now());
    const key=await decryptCredential(this.env.AI_ENCRYPTION_KEY,s.encryptedKey),config={...s.config,maxOutputTokens:128,timeoutSeconds:20};
    const chat=await completion(config,key,[{role:'user',content:'Reply with OK.'}],[]);
    const tool=await completion(config,key,[{role:'user',content:'Call connection_test with ok=true.'}],[{type:'function',function:{name:'connection_test',description:'Test tool support',parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}}],undefined,true);
    let streaming=false;try {await completion(config,key,[{role:'user',content:'Reply with OK.'}],[],async()=>{});streaming=true;}catch{ /* Some compatible providers support JSON completions only. */ }
    const capabilities={chat:!!chat.text,tools:tool.calls.some(c=>c.function.name==='connection_test'),streaming};
    return this.serial(async()=>{const current=await this.state();if(current.config.revision!==s.config.revision)throw new AIError('Settings changed during the connection test. Test again.');current.capabilities=capabilities;current.tested=capabilities.chat&&capabilities.tools;await this.ctx.storage.put('settings',current);this.log(actor,'provider_test',capabilities);return this.view(actor);});
  }
  async reserve(userId:string,feature:AIFeature,id:string,input:number,review?:'screening'|'cleanup'){const policy=await this.policy(userId,feature);const c=review?reviewConfig(policy,review):policy;const now=Date.now(),day=Date.parse(new Date(now).toISOString().slice(0,10)),month=Date.parse(new Date(now).toISOString().slice(0,7)+'-01');
    if(!Number.isSafeInteger(input)||input<0||input>500000)throw new AIError('AI context exceeds the request budget');
    try{this.ctx.storage.transactionSync(()=>{
      const sql=this.ctx.storage.sql;
      if(sql.exec('SELECT id FROM ai_usage WHERE id=?',id).toArray().length)throw new AIError('AI attempt already reserved');
      const active=sql.exec<{n:number}>("SELECT count(*) n FROM ai_usage WHERE status='running' AND expires>?",now).one().n;if(active>=c.concurrentRequests)throw new AIError('Organization AI concurrency limit reached',true);
      if(sql.exec<{n:number}>('SELECT count(*) n FROM ai_usage WHERE user_id=? AND created>?',userId,now-60000).one().n>=c.requestsPerMinute)throw new AIError('AI request rate limit reached',true);
      const cost=(input*c.inputPrice+c.maxOutputTokens*c.outputPrice)/1e6;
      for(const [since,owner,limit]of [[day,userId,c.userDailyTokens],[month,userId,c.userMonthlyTokens],[day,'',c.orgDailyTokens],[month,'',c.orgMonthlyTokens]]as const){const row=sql.exec<{tokens:number}>('SELECT coalesce(sum(input+output),0) tokens FROM ai_usage WHERE created>=? AND (?=\'\' OR user_id=?)',since,owner,owner).one();if(row.tokens+input+c.maxOutputTokens>limit){throw new AIError('AI token allowance reached. Contact your administrator.');}}
      const spent=sql.exec<{cost:number}>('SELECT coalesce(sum(cost),0) cost FROM ai_usage WHERE created>=?',month).one().cost;if(c.monthlyBudgetUsd>0&&spent+cost>c.monthlyBudgetUsd)throw new AIError('Organization AI cost allowance reached');
      sql.exec('INSERT INTO ai_usage(id,user_id,model,created,expires,input,output,cost,status,input_price,output_price) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,userId,c.model,now,now+(c.timeoutSeconds+15)*1000,input,c.maxOutputTokens,cost,'running',c.inputPrice,c.outputPrice);
    });}catch(e){const safe=aiErrorInfo(e);if(safe)this.log(userId,'limit_hit',{message:safe.message});throw e;}return c;
  }
  async result(id:string,input:number|undefined,output:number|undefined,latency:number,failed:boolean){const row=this.ctx.storage.sql.exec<{input:number;output:number;cost:number;input_price:number;output_price:number}>('SELECT input,output,cost,input_price,output_price FROM ai_usage WHERE id=?',id).toArray()[0];if(!row)return;
    // Unknown usage stays fully charged; failed attempts may have reached the provider.
    const i=!failed&&Number.isSafeInteger(input)&&input!>=0?input!:row.input,o=!failed&&Number.isSafeInteger(output)&&output!>=0?output!:row.output;
    const cost=(i*row.input_price+o*row.output_price)/1e6;
    this.ctx.storage.sql.exec('UPDATE ai_usage SET input=?,output=?,cost=?,status=?,latency=? WHERE id=?',i,o,cost,failed?'failed':'complete',latency,id);
  }
  async credential(userId:string,feature:AIFeature,revision:number){const c=await this.policy(userId,feature);if(c.revision!==revision)throw new AIError('AI settings changed. Start a new request.');const s=await this.state();return {key:await decryptCredential(this.env.AI_ENCRYPTION_KEY!,s.encryptedKey),streaming:!!s.capabilities?.streaming};}
  async claimAutomatic(userId:string,id:string){const c=await this.policy(userId,'automation');const day=Date.parse(new Date().toISOString().slice(0,10));return this.ctx.storage.transactionSync(()=>{const sql=this.ctx.storage.sql;if(sql.exec('SELECT id FROM ai_auto WHERE id=?',id).toArray().length)return true;if(sql.exec<{n:number}>('SELECT count(*) n FROM ai_auto WHERE user_id=? AND created>=?',userId,day).one().n>=c.autoDraftsPerDay)return false;sql.exec('INSERT INTO ai_auto VALUES(?,?,?)',id,userId,Date.now());return true;});}
  async activity(actor:string){await this.admin(actor);return {totals:this.ctx.storage.sql.exec<{tokens:number;cost:number;requests:number}>('SELECT coalesce(sum(input+output),0) tokens,coalesce(sum(cost),0) cost,count(*) requests FROM ai_usage WHERE created>?',Date.now()-31*86400000).one(),audit:this.ctx.storage.sql.exec('SELECT * FROM ai_audit ORDER BY created DESC LIMIT 100').toArray(),versions:this.ctx.storage.sql.exec('SELECT id,created FROM ai_versions ORDER BY created DESC LIMIT 30').toArray(),usage:this.ctx.storage.sql.exec("SELECT user_id,model,strftime('%Y-%m-%d',created/1000,'unixepoch') day,sum(input) input,sum(output) output,sum(cost) cost,count(*) requests,sum(CASE WHEN status='failed' OR (status='running' AND expires<strftime('%s','now')*1000) THEN 1 ELSE 0 END) failures,avg(latency) latency FROM ai_usage WHERE created>? GROUP BY user_id,model,day ORDER BY day DESC LIMIT 500",Date.now()-31*86400000).toArray()};}
  async event(userId:string,action:string){this.log(userId,action);}
  async retention(){return (await this.state()).config.retentionDays;}
  async alarm(){const c=(await this.state()).config;this.ctx.storage.sql.exec('DELETE FROM ai_audit WHERE created<?',Date.now()-c.auditRetentionDays*86400000);this.ctx.storage.sql.exec('DELETE FROM ai_usage WHERE created<?',Date.now()-Math.max(35,c.auditRetentionDays)*86400000);this.ctx.storage.sql.exec('DELETE FROM ai_auto WHERE created<?',Date.now()-2*86400000);this.ctx.storage.sql.exec('DELETE FROM ai_versions WHERE id NOT IN (SELECT id FROM ai_versions ORDER BY created DESC LIMIT 30)');await this.ctx.storage.setAlarm(Date.now()+86400000);}
}

export function reviewConfig(c:AIConfig,kind:'screening'|'cleanup'):AIConfig {
  if(!(kind==='screening'?c.screenIncoming:c.cleanDrafts))throw new AIError('AI review is disabled');
  return {...c,model:(kind==='screening'?c.screeningModel:c.cleanupModel)||c.model,timeoutSeconds:c.reviewTimeoutSeconds,maxOutputTokens:kind==='screening'?128:c.reviewMaxOutputTokens,inputPrice:c.reviewInputPrice,outputPrice:c.reviewOutputPrice};
}
