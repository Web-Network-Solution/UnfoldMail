import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { Env } from '../types';
import { assistant, control, runReadTool } from './ai-tools';

// One server per request: no session state or credentials shared between employees.
// The route has already consumed the body; undefined (invalid JSON) makes the transport answer with a parse error.
export async function serveMcp(request:Request,env:Env,userId:string,scopes:string[],parsedBody:unknown) {
  const server=new McpServer({name:'private-webmail',version:'1.1.0'});
  const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  const call=async(name:string,args:Record<string,unknown>)=>{
    try {
      const policy=await control(env).policy(userId,'mcp');
      const result=name==='propose_draft'?await assistant(env,userId).mcpProposal(userId,args):await runReadTool(env,userId,name,args,policy,[]);
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    }catch{return {isError:true,content:[{type:'text' as const,text:'Tool could not complete. Check permissions and arguments.'}]};}
  };
  if(scopes.includes('read')) {
    server.registerTool('search_emails',{description:'Search subject, sender and snippet in your mailbox. Messages in Trash are excluded.',inputSchema:{query:z.string().max(200)},annotations:{readOnlyHint:true}},args=>call('search_emails',args));
    server.registerTool('read_email',{description:'Read an email and bounded thread context in your mailbox. Thread context omits messages in Trash; a trashed message is still readable by ID.',inputSchema:{emailId:z.string().min(1).max(100)},annotations:{readOnlyHint:true}},args=>call('read_email',args));
  }
  if(scopes.includes('draft'))server.registerTool('propose_draft',{description:'Prepare a draft proposal for approval in webmail. Cannot send.',inputSchema:{to:z.string().email().max(254),subject:z.string().max(998),body:z.string().min(1).max(16000)},annotations:{destructiveHint:false}},args=>call('propose_draft',args));
  await server.connect(transport);
  try{return await transport.handleRequest(request,{parsedBody});}finally{await server.close();}
}
