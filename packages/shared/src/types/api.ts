// ─── API Response Wrappers ────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  /** GET /emails/:id — true when this request cleared the unread flag. */
  markedRead?: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: Pagination;
}

// ─── Search Types ─────────────────────────────────────────────────

export interface SearchRequest {
  query: string;
  folderId?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  id: string;
  subject: string;
  sender: string;
  senderName?: string;
  snippet: string;
  receivedAt: string;
  folderId: string;
  threadId: string;
  isArchived: boolean;
  isRead: boolean;
  hasAttachments: boolean;
}

// ─── Retention Types ──────────────────────────────────────────────

export interface RetentionPolicy {
  archiveAfterDays: number;
  deleteTrashAfterDays: number;
}

// ─── Admin Stats ──────────────────────────────────────────────────

export interface AdminStats {
  databaseBytes?: number;
  databaseLimitBytes?: number;
  totalUsers: number;
  totalEmails: number;
  totalAttachments: number;
  storageUsedBytes: number;
  emailsToday: number;
  emailsThisWeek: number;
  emailDomain: string;
}

export interface BulkImportResult {
  results: { email: string; status: 'created' | 'skipped'; reason?: string }[];
  summary: { total: number; created: number; skipped: number };
}

// ─── Admin Reports ────────────────────────────────────────────────

export interface AdminReportSummary {
  totalSent: number;
  totalReceived: number;
  totalEmails: number;
  totalAttachments: number;
  attachmentBytes: number;
  totalSharedFiles: number;
  sharedFilesBytes: number;
  emailBytes: number;
  totalStorageBytes: number;
  activeUsers: number;
}

export interface AdminDailyActivity {
  date: string;
  sent: number;
  received: number;
  totalEmails: number;
  storageBytes: number;
  attachmentBytes: number;
}

export interface AdminUserActivity {
  id: string;
  email: string;
  displayName: string;
  role: string;
  sent: number;
  received: number;
  totalEmails: number;
  storageUsedBytes: number;
}

export interface AdminReportResponse {
  freshness?: { updatedAt: string | null; missingMailboxes: number; staleMailboxes: number; historicalBaselineIncomplete: boolean };
  startDate: string;
  endDate: string;
  summary: AdminReportSummary;
  daily: AdminDailyActivity[];
  users: AdminUserActivity[];
}

// ─── WebSocket Event Types ────────────────────────────────────────

export type WsEventType = 'ai_updated' | 'delivery_updated' | 'new_email' | 'email_read' | 'email_deleted' | 'folder_updated' | 'ping' | 'pong';

export interface WsEvent {
  type: WsEventType;
  payload: unknown;
}

export interface WsNewEmailEvent extends WsEvent {
  type: 'new_email';
  payload: {
    emailId: string;
    threadId: string;
    sender: string;
    senderName?: string;
    subject: string;
    snippet: string;
    folderId: string;
    receivedAt: string;
    hasAttachments: boolean;
  };
}
