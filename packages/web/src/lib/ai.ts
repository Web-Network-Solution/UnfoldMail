import { request } from './api';
import type { ApiResponse,AIConfig,AISettingsView,AIPreferences,AITurn,AIFeature } from '@email-service/shared';
export type AIActivity={totals:{tokens:number;cost:number;requests:number};audit:{id:string;actor:string;action:string;created:number;details:string}[];versions:{id:string;created:number}[];usage:{user_id:string;model:string;day:string;input:number;output:number;cost:number;requests:number;failures:number;latency:number}[]};
const post=(body:unknown)=>({method:'POST',body:JSON.stringify(body)});
export const aiApi={
  settings:()=>request<ApiResponse<AISettingsView>>('/admin/ai'),
  save:(config:AIConfig,apiKey?:string,removeKey=false)=>request<ApiResponse<AISettingsView>>('/admin/ai',{...post({config,apiKey,removeKey}),method:'PUT'}),
  test:()=>request<ApiResponse<AISettingsView>>('/admin/ai/test',post({})),
  stop:()=>request<ApiResponse<AISettingsView>>('/admin/ai/stop',post({})),
  rollback:(id:string)=>request<ApiResponse<AISettingsView>>(`/admin/ai/rollback/${id}`,post({})),
  activity:()=>request<ApiResponse<AIActivity>>('/admin/ai/activity'),
  status:()=>request<ApiResponse<{enabled:boolean;provider?:string;model?:string;features?:Record<AIFeature,boolean>;retentionDays?:number}>>('/ai/status'),
  turns:()=>request<ApiResponse<AITurn[]>>('/ai/turns'),
  start:(prompt:string,mode:AITurn['mode'],emailId?:string,id:string=crypto.randomUUID())=>request<ApiResponse<AITurn>>('/ai/turns',post({id,prompt,mode,emailId})),
  cancel:(id:string)=>request<ApiResponse<void>>(`/ai/turns/${id}/cancel`,post({})),
  clear:()=>request<ApiResponse<void>>('/ai/turns',{method:'DELETE'}),
  decide:(id:string,action:string,approve:boolean)=>request<ApiResponse<AITurn>>(`/ai/turns/${id}/actions/${action}`,post({approve})),
  editProposal:(id:string,action:string,data:Record<string,unknown>)=>request<ApiResponse<AITurn>>(`/ai/turns/${id}/actions/${action}`,{method:'PUT',body:JSON.stringify(data)}),
  preferences:()=>request<ApiResponse<AIPreferences>>('/ai/preferences'),
  savePreferences:(v:AIPreferences)=>request<ApiResponse<AIPreferences>>('/ai/preferences',{...post(v),method:'PUT'}),
  tokens:()=>request<ApiResponse<{id:string;name:string;expires:number;scopes:string}[]>>('/ai/tokens'),
  token:(name:string,scopes:string[])=>request<ApiResponse<{token:string;id:string}>>('/ai/tokens',post({name,scopes})),
  revoke:(id:string)=>request<ApiResponse<void>>(`/ai/tokens/${id}`,{method:'DELETE'}),
};
export function openAI(prompt='',mode:AITurn['mode']='chat',emailId?:string,requestId?:string){window.dispatchEvent(new CustomEvent('open-ai',{detail:{prompt,mode,emailId,requestId}}));}
