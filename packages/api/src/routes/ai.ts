import { serveMcp } from '../services/ai-mcp';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env,HonoVariables } from '../types';
import { assistant,control } from '../services/ai-tools';
import { aiErrorInfo, AIError } from '../services/ai-provider';
import type { AITurn } from '@email-service/shared';
type App={Bindings:Env;Variables:HonoVariables};
export const aiRoutes=new Hono<App>(),aiAdminRoutes=new Hono<App>(),aiMcpRoutes=new Hono<App>();
for(const router of [aiRoutes,aiAdminRoutes,aiMcpRoutes]){router.use('*',bodyLimit({maxSize:100000}));router.onError((e,c)=>{const safe=aiErrorInfo(e);return c.json({success:false,error:safe?.message ?? 'AI service could not complete the request'},safe&&/rate limit/i.test(safe.message)?429:400);});}
aiAdminRoutes.use('*',async(c,next)=>{if(c.get('userRole')!=='super_admin')return c.json({success:false,error:'Super-admin access required'},403);await next();});
aiAdminRoutes.get('/',async c=>c.json({success:true,data:await control(c.env).view(c.get('userId'))}));
aiAdminRoutes.put('/',async c=>{const v=await c.req.json<{config:unknown;apiKey?:string;removeKey?:boolean}>();return c.json({success:true,data:await control(c.env).save(c.get('userId'),v.config,v.apiKey,v.removeKey===true)});});
aiAdminRoutes.post('/test',async c=>c.json({success:true,data:await control(c.env).test(c.get('userId'))}));
aiAdminRoutes.post('/stop',async c=>c.json({success:true,data:await control(c.env).stop(c.get('userId'))}));
aiAdminRoutes.post('/rollback/:id',async c=>c.json({success:true,data:await control(c.env).rollback(c.get('userId'),c.req.param('id'))}));
aiAdminRoutes.get('/activity',async c=>c.json({success:true,data:await control(c.env).activity(c.get('userId'))}));
aiRoutes.get('/status',async c=>{try{const p=await control(c.env).policy(c.get('userId'));return c.json({success:true,data:{enabled:true,provider:new URL(p.baseUrl).hostname,model:p.model,features:p.features,retentionDays:p.retentionDays}});}catch{return c.json({success:true,data:{enabled:false}});}});
aiRoutes.get('/turns',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).snapshot(c.get('userId'))}));
aiRoutes.post('/turns',async c=>{const input=await c.req.json<{id:string;prompt:string;mode:AITurn['mode'];emailId?:string}>();return c.json({success:true,data:await assistant(c.env,c.get('userId')).start(c.get('userId'),input)},202);});
aiRoutes.delete('/turns',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).clear(c.get('userId'))}));
aiRoutes.post('/turns/:id/cancel',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).cancel(c.get('userId'),c.req.param('id'))}));
aiRoutes.post('/turns/:id/actions/:action',async c=>{const v=await c.req.json<{approve:boolean}>();if(typeof v.approve!=='boolean')throw new AIError('Choose approve or reject');return c.json({success:true,data:await assistant(c.env,c.get('userId')).decide(c.get('userId'),c.req.param('id'),c.req.param('action'),v.approve)});});
aiRoutes.put('/turns/:id/actions/:action',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).editProposal(c.get('userId'),c.req.param('id'),c.req.param('action'),await c.req.json())}));
aiRoutes.get('/preferences',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).preferences(c.get('userId'))}));
aiRoutes.put('/preferences',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).setPreferences(c.get('userId'),await c.req.json())}));
aiRoutes.get('/tokens',async c=>c.json({success:true,data:await assistant(c.env,c.get('userId')).tokens(c.get('userId'))}));
aiRoutes.post('/tokens',async c=>{const v=await c.req.json<{name:string;scopes:string[]}>();return c.json({success:true,data:await assistant(c.env,c.get('userId')).createToken(c.get('userId'),v.name,v.scopes)});});
aiRoutes.delete('/tokens/:id',async c=>{await assistant(c.env,c.get('userId')).revokeToken(c.get('userId'),c.req.param('id'));return c.json({success:true});});

// Stateless MCP Streamable HTTP: bearer tokens are employee-scoped, revocable,
// never cookie-authenticated. No sending or deletion tools are exposed.
aiMcpRoutes.post('/',async c=>{
  const token=(c.req.header('Authorization')||'').replace(/^Bearer /,'');const parts=token.split('.');
  if(parts.length!==4||parts[0]!=='ai'||parts.some(p=>p.length>150))return c.json({error:'Invalid credential'},401);
  // Unknown IDs must not instantiate (and persist schema in) a Durable Object for unauthenticated callers.
  if(!await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(parts[1]).first())return c.json({error:'Invalid credential or MCP disabled'},401);
  const userId=parts[1],agent=assistant(c.env,userId);let scopes:string[];try{scopes=await agent.verifyToken(userId,parts[2],token);}catch{return c.json({error:'Invalid credential or MCP disabled'},401);}
  // Rate admission counts HTTP requests, so a JSON-RPC batch would run many calls for one slot. MCP 2025-06-18 dropped batching.
  const body=await c.req.json().catch(()=>undefined);if(Array.isArray(body))return c.json({error:'Batch requests are not supported'},400);
  await agent.admitMcp(userId);
  return serveMcp(c.req.raw,c.env,userId,scopes,body);
});
aiMcpRoutes.get('/',c=>c.body(null,405));
