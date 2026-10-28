// ─── System Folder Defaults ───────────────────────────────────────

export const SYSTEM_FOLDERS = ['inbox', 'sent', 'drafts', 'trash', 'archive'] as const;

export const SYSTEM_FOLDER_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  archive: 'Archive',
};

// ─── Defaults ─────────────────────────────────────────────────────

export const DEFAULT_RETENTION_POLICY = {
  archiveAfterDays: 365,
  deleteTrashAfterDays: 30,
};

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Compose attachment threshold. Leaves space for MIME encoding and the body. */
export const MAX_ATTACHMENT_SIZE = 3 * 1024 * 1024;
/** Files exceeding the compose attachment budget are uploaded to R2 as shared downloads, up to 1 GB. */
export const MAX_LARGE_FILE_SIZE = 1024 * 1024 * 1024;
/** Cloudflare Email Sending caps total message size (body + attachments) at 5 MiB for general recipients. */
export const MAX_OUTBOUND_MESSAGE_SIZE = 5 * 1024 * 1024;
/** Conservative budget for headers and multipart boundaries. */
export const MESSAGE_OVERHEAD_BYTES = 32 * 1024;
export function encodedMessageBytes(bytes: number): number {
  const base64 = Math.ceil(bytes / 3) * 4;
  return base64 + Math.ceil(base64 / 76) * 2;
}
/** Cloudflare Email Sending caps to + cc + bcc at 50 addresses. */
export const MAX_RECIPIENTS = 50;

export const SNIPPET_LENGTH = 200;

// ─── R2 Key Prefixes ─────────────────────────────────────────────

export const R2_PREFIXES = {
  /** Raw inbound MIME, staged by the email() handler for the queue consumer. */
  inbound: 'inbound',
  emailBody: 'emails',
  attachments: 'attachments',
  /** Compose uploads not yet bound to a sent email. */
  uploads: 'uploads',
} as const;

// ─── WebSocket ────────────────────────────────────────────────────

export const WS_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
export const WS_RECONNECT_DELAY_MS = 3_000;     // 3 seconds
export const WS_MAX_RECONNECT_DELAY_MS = 30_000; // cap the exponential backoff
export const WS_MAX_RECONNECT_ATTEMPTS = 10;

// ─── Auth ─────────────────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 8;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Failed logins allowed per email address inside LOGIN_ATTEMPT_WINDOW_MS. */
export const MAX_LOGIN_ATTEMPTS = 10;
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
