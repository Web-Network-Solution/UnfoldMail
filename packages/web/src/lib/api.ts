/**
 * API Client — typed fetch wrapper for the email service API.
 */
import type {
  ApiResponse,
  PaginatedResponse,
  Email,
  Folder,
  Thread,
  Attachment,
  PendingAttachment,
  SearchResult,
  AdminStats,
  AdminReportResponse,
  RetentionPolicy,
  BulkImportResult,
  User,
  ComposeEmailRequest,
  ForwardingConfig, ForwardingPolicy, ForwardingActivity, ForwardingPreview, MailFilter,
} from '@email-service/shared';
import { UploadTask, type NetworkHint, type UploadSnapshot, type UploadSession, type UploadStatus, type UploadResult } from './upload-manager';
import type { Contact, ContactInput, CalendarEvent, CalendarInput, CalendarDelivery, Attendance } from '@email-service/shared';
import { useAuthStore } from '../stores';

export const contactsApi = {
 list: (q='',group='',page=0) => request<ApiResponse<{contacts:Contact[];total:number;groups:string[]}>>(`/contacts?${new URLSearchParams({q,group,page:String(page)})}`),
 directory: (q='',page=0) => request<ApiResponse<{contacts:Contact[];hasMore:boolean}>>(`/contacts/directory?${new URLSearchParams({q,page:String(page)})}`),
 suggest: (q:string) => request<ApiResponse<{name:string;email:string}[]>>(`/contacts/suggest?q=${encodeURIComponent(q)}`),
 save: (v:ContactInput & {id?:string;revision?:number}) => request<ApiResponse<Contact>>(v.id?`/contacts/${v.id}`:'/contacts',{method:v.id?'PUT':'POST',body:JSON.stringify(v)}),
 delete: (id:string) => request<ApiResponse<void>>(`/contacts/${id}`,{method:'DELETE'}),
 import: (content:string,format:string) => request<ApiResponse<{imported:number;skipped:number}>>('/contacts/import',{method:'POST',body:JSON.stringify({content,format})}),
};
export const calendarApi = {
 list:(from:string,to:string,cancelled=false)=>request<ApiResponse<CalendarEvent[]>>(`/calendar?${new URLSearchParams({from,to,cancelled:String(cancelled)})}`),
 get:(id:string)=>request<ApiResponse<CalendarEvent>>(`/calendar/${id}`),
 save:(v:CalendarInput & {id?:string;revision?:number})=>request<ApiResponse<CalendarEvent>>(v.id?`/calendar/${v.id}`:'/calendar',{method:v.id?'PUT':'POST',body:JSON.stringify(v)}),
 cancel:(id:string,revision:number,occurrence?:string)=>request<ApiResponse<void>>(`/calendar/${id}/cancel`,{method:'POST',body:JSON.stringify({revision,occurrence})}),
 delete:(id:string)=>request<ApiResponse<void>>(`/calendar/${id}`,{method:'DELETE'}),
 respond:(id:string,response:Attendance)=>request<ApiResponse<void>>(`/calendar/${id}/respond`,{method:'POST',body:JSON.stringify({response})}),
 deliveries:(id:string)=>request<ApiResponse<CalendarDelivery[]>>(`/calendar/${id}/deliveries`),
 retry:(id:string,job:string,acknowledgeDuplicate:boolean)=>request<ApiResponse<void>>(`/calendar/${id}/deliveries/${job}/retry`,{method:'POST',body:JSON.stringify({acknowledgeDuplicate})}),
 preview:(content:string,timezone:string)=>request<ApiResponse<CalendarInput[]>>('/calendar/import/preview',{method:'POST',body:JSON.stringify({content,timezone})}),
 import:(content:string,timezone:string)=>request<ApiResponse<{imported:number}>>('/calendar/import',{method:'POST',body:JSON.stringify({content,timezone})}),
 rsvp:(token:string,response?:Attendance)=>request<ApiResponse<Pick<CalendarEvent,'title'|'description'|'location'|'meeting'|'start'|'end'|'timezone'|'allDay'|'recurrence'|'organizer'|'status'> & {email:string;response:Attendance}>>('/calendar-rsvp',{method:'POST',body:JSON.stringify({token,response})}),
};

export async function downloadProductivity(path:string,filename:string) {
 const r=await fetch(`${API_BASE}${path}`,{credentials:'include'});
 if(!r.ok)throw new Error((await r.json().catch(()=>null))?.error||'Download failed');
 const url=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/**
 * Same-origin by default: the Worker serves the SPA from its own `assets`
 * binding, which keeps the session cookie and the WebSocket on one origin.
 * Set VITE_API_BASE only for a genuinely split deployment (and then the API's
 * APP_URL must list this origin for CORS).
 */
export const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '') + '/api';

export interface MailboxStorageRow {
  id:string; email:string; display_name:string; state:'d1'|'copying'|'verified'|'active';
  database_bytes:number|null; emails:number|null; metrics_updated_at:string|null;
}
export const mailboxStorageApi = {
  list:()=>request<ApiResponse<MailboxStorageRow[]>>('/admin/mailboxes'),
};

export const forwardingApi = {
  get: () => request<ApiResponse<{ config: ForwardingConfig; policy: ForwardingPolicy }>>('/forwarding'),
  save: (config: ForwardingConfig) => request<ApiResponse<ForwardingConfig>>('/forwarding', { method: 'PUT', body: JSON.stringify(config) }),
  preview: (rule: MailFilter) => request<ApiResponse<ForwardingPreview>>('/forwarding/preview', { method: 'POST', body: JSON.stringify(rule) }),
  activity: () => request<ApiResponse<ForwardingActivity[]>>('/forwarding/activity'),
  delivery: (id: string, action: 'retry' | 'cancel', acknowledgeDuplicate = false) => request<ApiResponse<void>>(`/forwarding/activity/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify({ acknowledgeDuplicate }) }),
  policy: () => request<ApiResponse<ForwardingPolicy>>('/admin/forwarding'),
  savePolicy: (policy: ForwardingPolicy) => request<ApiResponse<ForwardingPolicy>>('/admin/forwarding', { method: 'PUT', body: JSON.stringify(policy) }),
  audit: (before = '') => request<ApiResponse<{ id: string; actor_email: string; action: string; details: string; created_at: string }[]>>(`/admin/forwarding/audit?before=${encodeURIComponent(before)}`),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Fired when the API says the user must change their password before continuing. */
export const PASSWORD_RESET_REQUIRED = 'PASSWORD_RESET_REQUIRED';

/** Who a request speaks for. Switch Back changes isImpersonating before the user. */
export const identity = () => { const s = useAuthStore.getState(); return `${s.user?.id}|${s.isImpersonating}`; };

/**
 * Mounted composers. Not the store's isComposeOpen: leaving /mail unmounts the
 * composer without closing it in the store, and that flag then blocked every
 * sign-out on /settings and /admin.
 */
export const composers = { open: 0 };

/**
 * Drop to the sign-in screen after a 401, unless the identity changed since the
 * request left: a late 401 from the previous session (Switch Back, a new
 * sign-in) must not sign the new one out. Never while composing either: signing
 * out unmounts the composer and its unsent text; its own send shows the error.
 */
export function signOutIfUnchanged(who: string) {
  if (identity() !== who || composers.open) return;
  useAuthStore.getState().stopImpersonation();
  useAuthStore.getState().setUser(null);
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const who = identity();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers:
      options.body instanceof FormData
        ? (options.headers as HeadersInit)
        : { 'Content-Type': 'application/json', ...options.headers },
    credentials: 'include',
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // An expired or revoked session drops to the sign-in screen instead of
    // leaving every view erroring until a reload. /auth/* is excluded: a 401
    // there is a wrong password or the normal logged-out /auth/me probe.
    if (res.status === 401 && !path.startsWith('/auth/')) signOutIfUnchanged(who);
    throw new ApiError(
      res.status,
      (body && (body.error as string)) || res.statusText || 'Request failed',
      body && (body.code as string)
    );
  }

  return body as T;
}

// ─── Auth ─────────────────────────────────────────────────────────

export const authApi = {
  needsBootstrap: () => request<ApiResponse<{ needsBootstrap: boolean }>>('/auth/needs-bootstrap'),

  bootstrap: (data: { email: string; displayName: string; password: string; bootstrapSecret: string }) =>
    request<ApiResponse<{ id: string; email: string }>>('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // A fresh sign-in is never an impersonation: a flag left in localStorage by a
  // session that died while the tab was closed would show a false banner.
  login: (email: string, password: string) =>
    request<ApiResponse<{ user: User }>>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }).then((res) => {
      useAuthStore.getState().stopImpersonation();
      return res;
    }),

  logout: () => request<ApiResponse<void>>('/auth/logout', { method: 'POST' }),

  me: () => request<ApiResponse<User>>('/auth/me'),

  resetPassword: (currentPassword: string, newPassword: string) =>
    request<ApiResponse<void>>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  updateSignature: (signatureHtml: string) =>
    request<ApiResponse<void>>('/auth/signature', {
      method: 'PUT',
      body: JSON.stringify({ signatureHtml }),
    }),

  impersonate: (targetUserId: string) =>
    request<ApiResponse<{ targetEmail: string; targetDisplayName: string }>>('/auth/impersonate', {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    }),

  stopImpersonate: () =>
    request<ApiResponse<void>>('/auth/stop-impersonate', { method: 'POST' }),
};

// ─── Emails ───────────────────────────────────────────────────────

export const emailApi = {
  list: (params: { folderId?: string; page?: number; pageSize?: number; starred?: boolean }) => {
    const search = new URLSearchParams();
    if (params.folderId) search.set('folderId', params.folderId);
    if (params.page) search.set('page', String(params.page));
    if (params.pageSize) search.set('pageSize', String(params.pageSize));
    if (params.starred) search.set('starred', 'true');
    return request<PaginatedResponse<Email>>(`/emails?${search}`);
  },

  get: (id: string, signal?: AbortSignal) => request<ApiResponse<Email>>(`/emails/${id}`, { signal, cache: 'no-store' }),

  markRead: (id: string, isRead: boolean) =>
    request<ApiResponse<void>>(`/emails/${id}/read`, {
      method: 'PATCH',
      body: JSON.stringify({ isRead }),
    }),

  toggleStar: (id: string, isStarred: boolean) =>
    request<ApiResponse<void>>(`/emails/${id}/star`, {
      method: 'PATCH',
      body: JSON.stringify({ isStarred }),
    }),

  move: (id: string, folderId: string) =>
    request<ApiResponse<void>>(`/emails/${id}/move`, {
      method: 'PATCH',
      body: JSON.stringify({ folderId }),
    }),

  delete: (id: string, permanent = false) =>
    request<ApiResponse<void>>(`/emails/${id}?permanent=${permanent}`, { method: 'DELETE' }),

  send: (data: ComposeEmailRequest) =>
    request<
      ApiResponse<{
        emailId: string;
        threadId: string;
        messageId?: string;
        deliveryStatus?: Email['deliveryStatus'];
        isDraft: boolean;
        attachmentCount?: number;
      }>
    >('/emails/send', { method: 'POST', body: JSON.stringify(data) }),

  listThreads: (params: { folderId?: string; page?: number; pageSize?: number }) => {
    const search = new URLSearchParams();
    if (params.folderId) search.set('folderId', params.folderId);
    if (params.page) search.set('page', String(params.page));
    if (params.pageSize) search.set('pageSize', String(params.pageSize));
    return request<PaginatedResponse<Thread>>(`/emails/threads?${search}`);
  },

  resolveDelivery: (emailId: string, outcome: 'delivered' | 'not_delivered') => request<ApiResponse<void>>(`/emails/${emailId}/resolve-delivery`, { method: 'POST', body: JSON.stringify({ outcome }) }),
  retry: (emailId: string) => request<ApiResponse<void>>(`/emails/${emailId}/retry`, { method: 'POST' }),
  getThread: (threadId: string, before?: string) =>
    request<ApiResponse<{ id: string; emails: Email[]; nextCursor?: string }>>(`/emails/threads/${threadId}${before ? '?before=' + encodeURIComponent(before) : ''}`),
};

// ─── Folders ──────────────────────────────────────────────────────

export const folderApi = {
  list: () => request<ApiResponse<Folder[]>>('/folders'),

  create: (name: string) =>
    request<ApiResponse<Folder>>('/folders', { method: 'POST', body: JSON.stringify({ name }) }),

  delete: (id: string) => request<ApiResponse<void>>(`/folders/${id}`, { method: 'DELETE' }),
};

// ─── Search ───────────────────────────────────────────────────────

export const searchApi = {
  search: (params: { q: string; folderId?: string; includeArchived?: boolean; includeTrash?: boolean; page?: number }) => {
    const search = new URLSearchParams();
    search.set('q', params.q);
    if (params.folderId) search.set('folderId', params.folderId);
    // Always sent explicitly. The API includes archived mail by default, so
    // omitting the param when the box is unchecked silently ignored the user's
    // choice instead of narrowing the search.
    if (params.includeArchived !== undefined) {
      search.set('includeArchived', String(params.includeArchived));
    }
    if (params.includeTrash) search.set('includeTrash', 'true');
    if (params.page) search.set('page', String(params.page));
    return request<PaginatedResponse<SearchResult>>(`/search?${search}`);
  },
};

// ─── Attachments ──────────────────────────────────────────────────

export const attachmentApi = {
  upload: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<ApiResponse<PendingAttachment>>('/attachments/upload', {
      method: 'POST',
      body: formData,
    });
  },

  createLargeUpload: (file: File, changed: (snapshot: UploadSnapshot) => void) => {
    async function data<T>(path:string, options:RequestInit={}) {
      const response=await request<ApiResponse<T>>(`/attachments/large-uploads${path}`,{signal:AbortSignal.timeout(60000),...options});
      if(!response.data)throw new Error('Upload service returned an invalid response');
      return response.data;
    }
    const task=new UploadTask(file,{
      start:(file,partSize)=>data<UploadSession>('',{method:'POST',body:JSON.stringify({filename:file.name,size:file.size,mimeType:file.type,partSize})}),
      status:id=>data<UploadStatus>(`/${id}`),
      complete:id=>data<UploadResult>(`/${id}/complete`,{method:'POST'}),
      cancel:async id=>{await request(`/attachments/large-uploads/${id}`,{method:'DELETE',signal:AbortSignal.timeout(30000)});},
      part:(id,number,body,signal,progress)=>new Promise<void>((resolve,reject)=>{
        if(signal.aborted){reject(new DOMException('Paused','AbortError'));return;}
        const xhr=new XMLHttpRequest();
        let stall:ReturnType<typeof setTimeout>;
        const cleanup=()=>{clearTimeout(stall);signal.removeEventListener('abort',abort);};
        const abort=()=>xhr.abort();
        const touch=()=>{clearTimeout(stall);stall=setTimeout(()=>{cleanup();reject(new ApiError(408,'Upload stalled. Retrying this chunk.'));xhr.abort();},60000);};
        xhr.open('PUT',`${API_BASE}/attachments/large-uploads/${id}/parts/${number}`);
        xhr.withCredentials=true;
        xhr.setRequestHeader('Content-Type','application/octet-stream');
        xhr.upload.onprogress=event=>{touch();progress(Math.min(event.loaded,body.size));};
        xhr.onload=()=>{
          cleanup();
          if(xhr.status>=200&&xhr.status<300){resolve();return;}
          let message='Chunk upload failed';try{message=JSON.parse(xhr.responseText).error||message;}catch{}
          reject(new ApiError(xhr.status,message));
        };
        xhr.onerror=()=>{cleanup();reject(new ApiError(0,'Connection interrupted. Retrying this chunk.'));};
        xhr.onabort=()=>{cleanup();reject(new DOMException('Paused','AbortError'));};
        signal.addEventListener('abort',abort,{once:true});touch();xhr.send(body);
      }),
    },changed,()=> (navigator as Navigator & {connection?:NetworkHint}).connection || {});
    const offline=()=>task.connection(false), online=()=>task.connection(true);
    window.addEventListener('offline',offline);window.addEventListener('online',online);
    const cleanup=()=>{window.removeEventListener('offline',offline);window.removeEventListener('online',online);};
    void task.result.then(cleanup,cleanup);
    if(!navigator.onLine)task.connection(false);
    return task;
  },

  download: (id: string) => `${API_BASE}/attachments/${id}/download`,

  listForEmail: (emailId: string) =>
    request<ApiResponse<Attachment[]>>(`/attachments/email/${emailId}`),
};

// ─── Admin ────────────────────────────────────────────────────────

export const adminApi = {
  listUsers: () => request<ApiResponse<User[]>>('/admin/users'),

  createUser: (data: {
    email: string;
    displayName: string;
    password: string;
    role?: string;
    mustResetPassword?: boolean;
  }) => request<ApiResponse<User>>('/admin/users', { method: 'POST', body: JSON.stringify(data) }),

  updateUser: (
    id: string,
    data: {
      displayName?: string;
      role?: string;
      mustResetPassword?: boolean;
      newPassword?: string;
    }
  ) =>
    request<ApiResponse<void>>(`/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteUser: (id: string) => request<ApiResponse<void>>(`/admin/users/${id}`, { method: 'DELETE' }),

  bulkImport: (csvFile: File) => {
    const formData = new FormData();
    formData.append('csv', csvFile);
    return request<ApiResponse<BulkImportResult>>('/admin/users/bulk', {
      method: 'POST',
      body: formData,
    });
  },

  getRetention: () => request<ApiResponse<RetentionPolicy>>('/admin/retention'),

  updateRetention: (data: Partial<RetentionPolicy>) =>
    request<ApiResponse<void>>('/admin/retention', { method: 'PUT', body: JSON.stringify(data) }),

  getStats: () => request<ApiResponse<AdminStats>>('/admin/stats'),

  getReports: (params?: { startDate?: string; endDate?: string }, signal?: AbortSignal) => {
    const search = new URLSearchParams();
    if (params?.startDate) search.set('startDate', params.startDate);
    if (params?.endDate) search.set('endDate', params.endDate);
    const qs = search.toString();
    return request<ApiResponse<AdminReportResponse>>(`/admin/reports${qs ? `?${qs}` : ''}`, { signal });
  },
};

export const meetingPolicyApi = {
  available: () => request<ApiResponse<import('@email-service/shared').MeetingProvider[]>>('/calendar/providers'),
  get: () => request<ApiResponse<import('@email-service/shared').MeetingProvider[]>>('/admin/meeting-providers'),
  save: (providers: import('@email-service/shared').MeetingProvider[]) => request<ApiResponse<import('@email-service/shared').MeetingProvider[]>>('/admin/meeting-providers', {method:'PUT',body:JSON.stringify({providers})}),
};
