export const AI_FEATURES = ['chat','summaries','writing','drafts','organize','calendar','contacts','automation','attachments','mcp','send'] as const;
export type AIFeature = typeof AI_FEATURES[number];
export interface AIConfig {
  revision: number; enabled: boolean; baseUrl: string; model: string;
  audience: 'all'|'selected'; employees: string[];
  features: Record<AIFeature, boolean>;
  maxSteps: number; maxOutputTokens: number; maxContextChars: number; maxEmails: number; historyMessages: number;
  timeoutSeconds: number; retries: number; requestsPerMinute: number; concurrentRequests: number;
  userDailyTokens: number; userMonthlyTokens: number; orgDailyTokens: number; orgMonthlyTokens: number;
  monthlyBudgetUsd: number; inputPrice: number; outputPrice: number;
  retentionDays: number; auditRetentionDays: number; autoDraftsPerDay: number;
  instructions: string; language: string; tone: string;
  screenIncoming: boolean; cleanDrafts: boolean;
  screeningModel: string; cleanupModel: string; reviewTimeoutSeconds: number;
  reviewMaxOutputTokens: number; reviewInputPrice: number; reviewOutputPrice: number;
}
export const DEFAULT_AI_CONFIG: AIConfig = {
  revision:0,enabled:false,baseUrl:'https://api.openai.com/v1',model:'',audience:'selected',employees:[],
  features:{chat:true,summaries:true,writing:true,drafts:true,organize:false,calendar:false,contacts:false,automation:false,attachments:false,mcp:false,send:false},
  maxSteps:5,maxOutputTokens:2048,maxContextChars:24000,maxEmails:10,historyMessages:12,
  timeoutSeconds:45,retries:1,requestsPerMinute:10,concurrentRequests:5,
  userDailyTokens:100000,userMonthlyTokens:1000000,orgDailyTokens:1000000,orgMonthlyTokens:10000000,
  monthlyBudgetUsd:100,inputPrice:0,outputPrice:0,retentionDays:30,auditRetentionDays:90,autoDraftsPerDay:10,
  instructions:'',language:'Match the employee’s language',tone:'Professional and concise',
  screenIncoming:false,cleanDrafts:false,screeningModel:'',cleanupModel:'',reviewTimeoutSeconds:20,
  reviewMaxOutputTokens:2048,reviewInputPrice:0,reviewOutputPrice:0,
};
export interface AIAutomationRule { id:string; name:string; enabled:boolean; sender:string; subject:string; instructions:string; }
export interface AIPreferences { instructions:string; automation:boolean; rules:AIAutomationRule[]; }
export type AIActionKind = 'draft'|'send'|'move'|'read'|'calendar'|'contact';
export interface AIAction { id:string; kind:AIActionKind; data:Record<string,unknown>; status:'pending'|'applying'|'applied'|'rejected'|'uncertain'; result?:unknown; review?:{status:'cleaned'|'unchanged'|'failed';originalBody:string;message:string}; }
export interface AISource { id:string; subject:string; sender:string; }
export interface AITurn {
  id:string; prompt:string; mode:'chat'|'summaries'|'writing'|'drafts'|'automation'; emailId?:string;
  text:string; status:'queued'|'running'|'complete'|'failed'|'cancelled'; error?:string; step:number;
  sources:AISource[]; actions:AIAction[]; activity:string[]; createdAt:number; attempts:number;
}
export interface AISettingsView { config:AIConfig; hasKey:boolean; keyHint:string; tested:boolean; capabilities:{chat:boolean;tools:boolean;streaming:boolean}|null; encryptionReady:boolean; }
