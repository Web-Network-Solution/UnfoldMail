import type { Database } from "./services/mailbox-storage";
/**
 * Cloudflare Worker environment bindings.
 * The wrangler.jsonc bindings the code reads, plus two synthetic fields:
 * mailboxEnv() sets CONTROL_DB and MAILBOX_USER_ID on a per-request copy. The
 * ASSETS binding is omitted because the runtime serves it and no code reads it.
 */
export interface Env {
  BOOTSTRAP_SECRET?: string;
  /** Shared with the private Go gateway; set using Wrangler secrets. */
  PROTOCOL_GATEWAY_SECRET?: string;
  AI_CONTROL?: DurableObjectNamespace<import('./durable-objects/ai-control').AIControlDO>;
  AI_ASSISTANTS?: DurableObjectNamespace<import('./durable-objects/ai-assistant').AIAssistantDO>;
  /** Base64 32-byte AES key, set only as a Worker secret. */
  AI_ENCRYPTION_KEY?: string;
  // ─── D1 Database ─────────────────────────────────────────
  DB: Database;
  CONTROL_DB?: Database;
  MAILBOX_USER_ID?: string;
  MAILBOXES?: DurableObjectNamespace<import('./durable-objects/mailbox').MailboxDO>;

  // ─── R2 Bucket ───────────────────────────────────────────
  EMAIL_BUCKET: R2Bucket;

  // ─── Queues ──────────────────────────────────────────────
  OUTBOUND_QUEUE: Queue<import('./services/outbox').OutboundJob | import('./services/forwarding').ForwardingQueueJob>;
  EMAIL_QUEUE: Queue<InboundEmailMessage>;

  // ─── Durable Objects ─────────────────────────────────────
  WEBSOCKET_HUB: DurableObjectNamespace;

  // ─── Email Sending ───────────────────────────────────────
  SEND_EMAIL: SendEmailBinding;

  // ─── Environment Variables ───────────────────────────────
  /** Mail domain, e.g. "yourdomain.com". Used for Message-ID generation. */
  EMAIL_DOMAIN: string;
  /** Deployed SPA origin, e.g. "https://mail.yourdomain.com". Drives CORS. */
  APP_URL: string;
  /** Optional comma-separated extra CORS origins (preview deploys). */
  EXTRA_ALLOWED_ORIGINS?: string;
  /** "production" tightens CORS by dropping localhost dev origins. */
  ENVIRONMENT?: string;
}

/**
 * Shape of the message enqueued when an inbound email arrives.
 *
 * Carries only a pointer: a Queue message is capped at 128 KB, so the raw MIME
 * is staged in R2 and fetched by the consumer.
 */
export interface InboundEmailMessage {
  /** Suppress AI automatic replies to automated/forwarded messages. Forwarding has separate loop checks. */
  automated?: boolean;
  /** R2 key of the staged raw RFC-822 message. */
  rawKey: string;
  /**
   * RFC Message-ID, used to deduplicate redeliveries. Stable across Email
   * Routing delivery attempts, unlike rawKey which is new each time.
   * Undefined when the sender omitted the header.
   */
  messageKey?: string;
  /** SMTP envelope sender (trusted; unlike the From: header). */
  from: string;
  /** SMTP envelope recipient — authoritative, and the only way to see Bcc. */
  to: string;
  /** Size of the raw message in bytes. */
  rawSize: number;
  /** ISO-8601 timestamp of receipt. */
  receivedAt: string;
}

// ─── Cloudflare Email Sending binding ────────────────────────────
// Shape per https://developers.cloudflare.com/email-service/ (Workers binding).
// `wrangler types` generates the authoritative version; this mirrors it so the
// project type-checks without a generated worker-configuration.d.ts.

export interface SendEmailAddress {
  email: string;
  name?: string;
}

export interface SendEmailAttachment {
  /** Raw content. Strings are sent as-is (NOT base64) by the Workers binding. */
  content: string | ArrayBuffer | ArrayBufferView;
  filename: string;
  type?: string;
  disposition?: 'attachment' | 'inline';
  contentId?: string;
}

export interface SendEmailMessage {
  from: string | SendEmailAddress;
  to: string | SendEmailAddress | (string | SendEmailAddress)[];
  cc?: string | SendEmailAddress | (string | SendEmailAddress)[];
  bcc?: string | SendEmailAddress | (string | SendEmailAddress)[];
  replyTo?: string | SendEmailAddress;
  subject: string;
  text?: string;
  html?: string;
  /** Only whitelisted headers are accepted; unknown headers are dropped. */
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
}

export interface SendEmailResponse {
  messageId?: string;
}

export interface SendEmailBinding {
  send(message: SendEmailMessage): Promise<SendEmailResponse | void>;
}

/**
 * Hono context variables set by middleware.
 */
export interface HonoVariables {
  userId: string;
  userEmail: string;
  userRole: 'super_admin' | 'admin' | 'employee';
  mustResetPassword: boolean;
  /** ISO expiry of the authenticated session; the realtime hub closes sockets past it. */
  sessionExpiresAt: string;
}

/**
 * A file part from multipart/form-data.
 *
 * @cloudflare/workers-types declares FormData.get() as `string | null`, but the
 * workerd runtime returns a File for file parts. Narrowing against that lossy
 * declaration collapses to `never`, so form handlers cast to this instead.
 */
export interface UploadedFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  stream(): ReadableStream;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Read a form field that may be a file or a plain string. */
export function formPart(form: FormData, name: string): UploadedFile | string | null {
  return form.get(name) as unknown as UploadedFile | string | null;
}
