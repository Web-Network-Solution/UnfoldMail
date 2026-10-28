import type { AIConfig } from '@email-service/shared';

export type ModelMessage = {role:'system'|'user'|'assistant'|'tool'; content:string|null; tool_calls?:ToolCall[]; tool_call_id?:string};
export type ToolCall = {id:string;type:'function';function:{name:string;arguments:string}};
export type ModelTool = {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}};
export class AIError extends Error { constructor(message:string,public retryable=false) {super(`AI_SAFE_${retryable?'RETRY':'STOP'}: ${message}`);this.name='Error';} }
// RPC preserves Error.message, but not custom prototypes or properties.
export function aiErrorInfo(error:unknown):{message:string;retryable:boolean}|null {
  if(!error||typeof error!=='object'||!('message' in error)||typeof error.message!=='string')return null;
  const match=/^AI_SAFE_(RETRY|STOP): ([\s\S]*)$/.exec(error.message);
  return match?{message:match[2],retryable:match[1]==='RETRY'}:null;
}
export function validateProviderUrl(raw:string):URL {
  let url:URL; try {url=new URL(raw);} catch {throw new AIError('Enter a valid HTTPS API base URL');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || (url.port && url.port!=='443') || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.') || /^\d+(\.\d+)*$/.test(url.hostname) || /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname)) throw new AIError('Use a public HTTPS hostname on port 443 without credentials, query or fragment');
  return url;
}
export function publicAddress(address:string):boolean {
  if(address.includes(':')){
    // Expand to eight 4-digit hextets so compressed and zero-padded spellings compare alike. Dotted (IPv4-embedded) forms are rejected.
    const halves=address.toLowerCase().split('::'),parts=halves.map(h=>h?h.split(':'):[]),given=parts.flat();
    if(halves.length>2||address.includes('.')||given.some(x=>!/^[0-9a-f]{1,4}$/.test(x))||(halves.length===2?given.length>7:given.length!==8))return false;
    const full=[...parts[0],...Array(8-given.length).fill('0'),...(parts[1]||[])].map(x=>x.padStart(4,'0')).join(':');
    // Global unicast 2000::/3 minus Teredo, documentation (2001:db8::/32, 3fff::/20), benchmarking, ORCHID and 6to4.
    return /^[23]/.test(full) && !/^(2001:0000|2001:0db8|2001:0002:0000|2001:001|2002|3fff:0)/.test(full);
  }
  const p=address.split('.').map(Number);
  return p.length===4 && p.every(n=>Number.isInteger(n)&&n>=0&&n<=255) && ![0,10,127].includes(p[0]) && p[0]<224 && !(p[0]===169&&p[1]===254) && !(p[0]===172&&p[1]>=16&&p[1]<=31) && !(p[0]===192&&(p[1]===168||(p[1]===0&&(p[2]===0||p[2]===2))||(p[1]===88&&p[2]===99))) && !(p[0]===100&&p[1]>=64&&p[1]<=127) && !(p[0]===198&&(p[1]===18||p[1]===19||(p[1]===51&&p[2]===100))) && !(p[0]===203&&p[1]===0&&p[2]===113);
}
async function assertPublicHost(host:string) {
  // Check both address families on every attempt. Redirects are never followed.
  const records=await Promise.all(['A','AAAA'].map(async type=>{
    // Resolver outages and timeouts are transient; only the address check below is final.
    let v:{Status?:number;Answer?:{type:number;data:string}[]};try{const r=await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,{headers:{accept:'application/dns-json'},signal:AbortSignal.timeout(5000)});
    // DoH reports SERVFAIL/REFUSED in band with HTTP 200; only NOERROR (0) and NXDOMAIN (3) are answers.
    if(!r.ok)throw new Error(`DNS HTTP ${r.status}`);v=await r.json<typeof v>();if(v.Status!==undefined&&v.Status!==0&&v.Status!==3)throw new Error(`DNS status ${v.Status}`);}catch{throw new AIError('Could not validate provider hostname',true);}
    return (v.Answer||[]).filter(a=>a.type===1||a.type===28).map(a=>a.data);
  }));
  const addresses=records.flat();
  if(!addresses.length||addresses.some(a=>!publicAddress(a)))throw new AIError('Provider hostname must resolve only to public IP addresses');
}
export async function encryptCredential(secret:string,value:string):Promise<string> {
  const bytes=Uint8Array.from(atob(secret),c=>c.charCodeAt(0));
  if(bytes.length!==32)throw new AIError('AI_ENCRYPTION_KEY must be a base64 encoded 32-byte secret');
  const key=await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('email-service-ai-v1')},key,new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...iv,...encrypted));
}
export async function decryptCredential(secret:string,value:string):Promise<string> {
  const key=await crypto.subtle.importKey('raw',Uint8Array.from(atob(secret),c=>c.charCodeAt(0)),'AES-GCM',false,['decrypt']);
  const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12),additionalData:new TextEncoder().encode('email-service-ai-v1')},key,bytes.slice(12)));
}
export async function completion(config:AIConfig,key:string,messages:ModelMessage[],tools:ModelTool[],onText?:(text:string)=>Promise<void>,forceTool=false) {
  const url=validateProviderUrl(config.baseUrl); await assertPublicHost(url.hostname);
  const signal=AbortSignal.timeout(config.timeoutSeconds*1000),send=(limit:'max_tokens'|'max_completion_tokens')=>fetch(url.href.replace(/\/$/,'')+'/chat/completions',{
    method:'POST',redirect:'manual',signal,
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
    body:JSON.stringify({model:config.model,messages,[limit]:config.maxOutputTokens,stream:!!onText,
      ...(onText?{stream_options:{include_usage:true}}:{}),...(tools.length?{tools,tool_choice:forceTool?'required':'auto'}:{})}),
  });
  let response:Response;try{response=await send('max_tokens');
    // Newer OpenAI models reject max_tokens and name its replacement. Switch only then: a provider unaware of max_completion_tokens could ignore the cap.
    // ponytail: one extra rejected request per call for such models; remember the choice per model if latency matters.
    if(response.status===400&&(await response.text()).includes('max_completion_tokens'))response=await send('max_completion_tokens');
  }catch{throw new AIError('Provider connection failed or timed out',true);}
  if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw new AIError(`Provider request failed (HTTP ${response.status}). Check the model, credentials and provider status.`,response.status===429||response.status>=500);}
  if(!response.body)throw new AIError('Provider returned an empty response');
  const reader=response.body.getReader(), decoder=new TextDecoder();let size=0,buffer='',text='',lastPublish=0;
  const calls:Record<number,ToolCall>={}; let usage:{prompt_tokens?:number;completion_tokens?:number}|undefined; let finished=false;
  try {
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>2*1024*1024)throw new AIError('Provider response exceeded 2 MiB');buffer+=decoder.decode(chunk.value,{stream:true});
      if(!onText)continue;
      let end:number;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){finished=true;continue;}if(!data)continue;
        const v=JSON.parse(data);if(v.error)throw new AIError('Provider stream reported an error');if(v.usage)usage=v.usage;
        const choice=v.choices?.[0];if(choice?.finish_reason)finished=true;const d=choice?.delta;
        if(typeof d?.content==='string')text+=d.content;
        for(const part of d?.tool_calls||[]){if(!Number.isInteger(part.index)||part.index<0||part.index>7)throw new AIError('Too many tool calls');const c=calls[part.index]??={id:'',type:'function',function:{name:'',arguments:''}};if(part.id)c.id=part.id;if(part.function?.name)c.function.name+=part.function.name;if(part.function?.arguments)c.function.arguments+=part.function.arguments;}
      }
      if(Date.now()-lastPublish>250){await onText(text);lastPublish=Date.now();}
    }
    if(onText){if(!finished)throw new AIError('Provider stream ended before completion',true);await onText(text);}
    else {const v=JSON.parse(buffer);if(v.error||!v.choices?.[0]?.message)throw new AIError('Provider returned an invalid completion');text=v.choices[0].message.content||'';for(const [i,c]of(v.choices[0].message.tool_calls||[]).entries())calls[i]=c;usage=v.usage;}
    return {text,calls:Object.values(calls),inputTokens:usage?.prompt_tokens,outputTokens:usage?.completion_tokens};
  } catch(e){if(aiErrorInfo(e))throw e;throw new AIError('Provider response was interrupted or invalid',true);} finally {await reader.cancel().catch(()=>undefined);}
}
