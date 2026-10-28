// Types
export type { Contact, ContactInput, Attendance, CalendarInput, CalendarEvent, CalendarDelivery } from './types/productivity';
export type { FilterConditions, FilterActions, MailFilter, ForwardingConfig, ForwardingPolicy, ForwardingActivity, ForwardingPreview } from './types/forwarding';
export type { User, UserRole, CreateUserRequest, UpdateUserRequest, BulkCreateUsersRequest, LoginRequest, ResetPasswordRequest } from './types/user';
export type {
  Folder, FolderType, SystemFolderType,
  Email, EmailAddress, Thread, Attachment, PendingAttachment,
  ComposeEmailRequest,
  EmailSignature,
} from './types/email';
export type {
  ApiResponse, PaginatedResponse, Pagination,
  SearchRequest, SearchResult,
  RetentionPolicy, AdminStats, BulkImportResult,
  AdminReportSummary, AdminDailyActivity, AdminUserActivity, AdminReportResponse,
  WsEventType, WsEvent, WsNewEmailEvent,
} from './types/api';

// Constants
export {
  SYSTEM_FOLDERS, SYSTEM_FOLDER_LABELS,
  DEFAULT_RETENTION_POLICY, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  MAX_ATTACHMENT_SIZE, MAX_LARGE_FILE_SIZE, MAX_OUTBOUND_MESSAGE_SIZE, MAX_RECIPIENTS, SNIPPET_LENGTH,
  R2_PREFIXES, MESSAGE_OVERHEAD_BYTES, encodedMessageBytes,
  WS_HEARTBEAT_INTERVAL_MS, WS_RECONNECT_DELAY_MS, WS_MAX_RECONNECT_DELAY_MS, WS_MAX_RECONNECT_ATTEMPTS,
  MIN_PASSWORD_LENGTH, SESSION_TTL_SECONDS, MAX_LOGIN_ATTEMPTS, LOGIN_ATTEMPT_WINDOW_MS,
} from './constants';

export { meetingProviders, validateMeeting, meetingText, createJitsiMeeting } from './meetings';
export type { CalendarMeeting, MeetingProvider } from './types/productivity';
export * from './ai';
