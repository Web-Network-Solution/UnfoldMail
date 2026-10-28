/**
 * D1 row → API DTO mappers.
 *
 * D1 returns snake_case columns. The shared `Email`/`User`/`Attachment` types
 * and the whole React app read camelCase. Routes used to spread raw rows and
 * camelCase only a handful of fields by hand, which left `receivedAt`,
 * `senderName`, `messageId`, `threadId` and `folderId` undefined on the wire —
 * showing up as "Invalid Date" in the UI and silently breaking reply threading.
 *
 * Every route now returns rows through these functions. Nothing spreads a raw
 * row.
 */
import type { Attachment, Email, EmailAddress, Folder, User } from '@email-service/shared';
import { toIso } from './utils';

export interface EmailRow {
  delivery_status?: Email['deliveryStatus'];
  delivery_error?: string | null;
  id: string;
  thread_id: string;
  folder_id: string;
  user_id: string;
  sender: string;
  sender_name: string | null;
  recipients_to: string | null;
  recipients_cc: string | null;
  recipients_bcc: string | null;
  subject: string | null;
  snippet: string | null;
  r2_body_key: string;
  is_read: number;
  is_starred: number;
  is_archived: number;
  has_attachments: number;
  size: number | null;
  in_reply_to: string | null;
  message_id: string | null;
  received_at: string;
}

function parseAddresses(json: string | null): EmailAddress[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a && typeof a.email === 'string')
      .map((a) => (a.name ? { email: a.email, name: a.name } : { email: a.email }));
  } catch {
    return [];
  }
}

export function mapEmail(row: EmailRow, extra: Partial<Email> = {}): Email {
  return {
    deliveryStatus: row.delivery_status,
    deliveryError: row.delivery_error || undefined,
    id: row.id,
    threadId: row.thread_id,
    folderId: row.folder_id,
    userId: row.user_id,
    sender: row.sender,
    senderName: row.sender_name || undefined,
    recipientsTo: parseAddresses(row.recipients_to),
    recipientsCc: parseAddresses(row.recipients_cc),
    recipientsBcc: parseAddresses(row.recipients_bcc),
    subject: row.subject || '',
    snippet: row.snippet || '',
    r2BodyKey: row.r2_body_key,
    isRead: !!row.is_read,
    isStarred: !!row.is_starred,
    isArchived: !!row.is_archived,
    hasAttachments: !!row.has_attachments,
    size: row.size || 0,
    inReplyTo: row.in_reply_to || undefined,
    messageId: row.message_id || undefined,
    receivedAt: toIso(row.received_at),
    ...extra,
  };
}

export interface AttachmentRow {
  id: string;
  email_id: string;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
  created_at: string;
  content_id?: string | null;
  disposition?: string | null;
}

export function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    emailId: row.email_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    r2Key: row.r2_key,
    createdAt: toIso(row.created_at),
    contentId: row.content_id || undefined,
    disposition: row.disposition === 'inline' ? 'inline' : 'attachment',
  };
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  must_reset_password: number;
  signature_html: string | null;
  created_at: string;
  updated_at: string;
}

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role === 'super_admin' ? 'super_admin' : row.role === 'admin' ? 'admin' : 'employee',
    mustResetPassword: !!row.must_reset_password,
    signatureHtml: row.signature_html || '',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface FolderRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  created_at: string;
  unread_count?: number;
}

export function mapFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type as Folder['type'],
    unreadCount: row.unread_count ?? 0,
    createdAt: toIso(row.created_at),
  };
}
