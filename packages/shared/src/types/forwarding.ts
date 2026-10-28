export interface FilterConditions {
  from?: string;
  fromDomain?: string;
  to?: string;
  subject?: string;
  contains?: string;
  excludes?: string;
  hasAttachments?: boolean;
  minBytes?: number;
  maxBytes?: number;
}
export interface FilterActions {
  forwardTo?: string[];
  folderId?: string;
  archive?: boolean;
  markRead?: boolean;
  star?: boolean;
}
export interface MailFilter {
  id: string;
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: FilterConditions;
  actions: FilterActions;
  stop: boolean;
}
export interface ForwardingConfig {
  revision: number;
  destinations: string[];
  forwardAll: string | null;
  rules: MailFilter[];
}
export interface ForwardingPolicy {
  enabled: boolean;
  allowExternal: boolean;
  allowedDomains: string[];
}
export interface ForwardingActivity {
  id: string;
  destination: string;
  subject: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'cancelled';
  error: string | null;
  created_at: string;
  attempts: number;
}
export interface ForwardingPreview {
  matches: { id: string; subject: string; sender: string; receivedAt: string }[];
  scanned: number;
  skipped: number;
}
