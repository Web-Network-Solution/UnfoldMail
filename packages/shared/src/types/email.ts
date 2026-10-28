// ─── Folder Types ─────────────────────────────────────────────────

export type SystemFolderType = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive';
export type FolderType = SystemFolderType | 'custom';

export interface Folder {
  id: string;
  userId: string;
  name: string;
  type: FolderType;
  unreadCount?: number;
  createdAt: string;
}

// ─── Email Types ──────────────────────────────────────────────────

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface Email {
  deliveryStatus?: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain';
  deliveryError?: string;
  id: string;
  threadId: string;
  folderId: string;
  userId: string;
  sender: string;
  senderName?: string;
  recipientsTo: EmailAddress[];
  recipientsCc: EmailAddress[];
  recipientsBcc: EmailAddress[];
  subject: string;
  snippet: string;
  r2BodyKey: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  hasAttachments: boolean;
  attachmentCount?: number;
  size: number;
  inReplyTo?: string;
  messageId?: string;
  receivedAt: string;
  /** Populated on detail view */
  bodyHtml?: string;
  bodyText?: string;
  attachments?: Attachment[];
}

export interface Thread {
  deliveryStatus?: Email['deliveryStatus'];
  id: string;
  subject: string;
  participants: string[];
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  snippet: string;
  hasAttachments: boolean;
  emails?: Email[];
}

// ─── Attachment Types ─────────────────────────────────────────────

export interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  mimeType: string;
  size: number;
  r2Key: string;
  createdAt: string;
  /** Content-ID for an inline part referenced by cid: in the HTML body. */
  contentId?: string;
  /** 'inline' parts are embedded images, not files the user attached. */
  disposition: 'inline' | 'attachment';
}

/** An attachment staged by POST /attachments/upload, not yet bound to an email. */
export interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  r2Key: string;
}

// ─── Compose Types ────────────────────────────────────────────────

export interface ComposeEmailRequest {
  requestId?: string;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  /** R2 keys returned by POST /attachments/upload. */
  attachmentKeys?: string[];
  /** IDs of attachments on an existing email to carry over (forward). */
  forwardAttachmentIds?: string[];
  /** RFC Message-ID of the message being replied to. */
  inReplyTo?: string;
  /** Save without sending. */
  isDraft?: boolean;
  /** Existing draft to overwrite instead of creating a new one. */
  draftId?: string;
}

// ─── Email Signature ──────────────────────────────────────────────

export interface EmailSignature {
  id: string;
  userId: string;
  name: string;
  htmlContent: string;
}
