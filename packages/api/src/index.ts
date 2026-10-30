import { syncSubdomainRouting } from "./services/setup-routing";
import setupRoutes from './routes/setup';
import { setupIdentity, setupBrowserEnv } from './services/setup-state';
import {protocolGateway,protocolSettings,protocolAdmin} from './routes/protocol';
import { aiRoutes, aiAdminRoutes, aiMcpRoutes } from './routes/ai';
import { mailboxEnv, MailboxUnavailable, provisionMailboxes } from './services/mailbox-storage';
import { mailboxAdminRoutes } from './routes/mailbox-admin';
import { cleanupDeletedMailboxes } from './services/mailbox-deletion';
import { MailboxReportPending } from './services/mailbox-reporting';
/**
 * Email Service API — Main Entry Point
 *
 * Exports:
 * - fetch()      → Hono REST API
 * - email()      → Cloudflare Email Routing handler (inbound)
 * - queue()      → Cloudflare Queue consumer (inbound, outbound and forwarding jobs)
 * - scheduled()  → Cron trigger handler (account cleanup, provisioning, calendar, central cleanup)
 * - Durable Object classes: MailboxDO (per-user mail store, runs outbox and
 *   retention alarms), WebSocketHub (real-time notifications), AIControlDO,
 *   AIAssistantDO
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env, HonoVariables, InboundEmailMessage } from './types';
import { authMiddleware, adminMiddleware } from './middleware/auth';
import { csrfGuard } from './middleware/csrf';
import { authRoutes } from './routes/auth';
import { emailRoutes } from './routes/emails';
import { folderRoutes } from './routes/folders';
import { contactRoutes } from './routes/contacts';
import { calendarRoutes, calendarRsvpRoutes } from './routes/calendar';
import { dispatchCalendar } from './services/calendar';
import { searchRoutes } from './routes/search';
import { attachmentRoutes } from './routes/attachments';
import { adminRoutes } from './routes/admin';
import { forwardingRoutes, forwardingAdminRoutes } from './routes/forwarding';
import { processForwarding, cleanupForwardingSnapshots, type ForwardingQueueJob } from './services/forwarding';
import { processInboundEmail } from './services/email-processor';
import { processOutbound, type OutboundJob } from './services/outbox';
import { runCentralCleanup } from './services/retention';
import { generateUUIDv7, inboundRawKey, nowIso, revokeSockets, sessionTag } from './lib/utils';
import { isAllowedOrigin } from './lib/origin';
import { getCookie } from 'hono/cookie';
import { SESSION_EXPIRES_HEADER, SESSION_TAG_HEADER } from './durable-objects/websocket-hub';

// Re-export the Durable Object class
export { AIControlDO } from './durable-objects/ai-control';
export { AIAssistantDO } from './durable-objects/ai-assistant';
export { MailboxDO } from './durable-objects/mailbox';
export { WebSocketHub } from './durable-objects/websocket-hub';

/** Cloudflare Email Routing will not deliver more than 25 MiB. */
const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

/** 60 one-minute republications ≈ 1 h of mailbox maintenance before ordinary retries. */
const MAX_MAINTENANCE_REPUBLISHES = 60;

type QueueJob = InboundEmailMessage | OutboundJob | ForwardingQueueJob;

// ─── Hono App ─────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

// Global middleware
app.use('*', logger());

// CORS is restricted to the configured app origins. Reflecting an arbitrary
// Origin while sending `credentials: true` lets any site read authenticated
// responses, which is a cross-origin account read.
app.use('/api/*', (c, next) =>
  cors({
    origin: (origin) => (isAllowedOrigin(origin, c.env) ? origin : null),
    credentials: true,
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next)
);

// Origin check on every mutating request. JSON bodies are already protected by
// the preflight, but multipart/form-data is not — see middleware/csrf.ts.
app.use('/api/*', csrfGuard);

// ─── Public Routes (no auth) ──────────────────────────────────────

app.route('/api/protocol-gateway', protocolGateway);
app.route('/api/ai-mcp', aiMcpRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/calendar-rsvp', calendarRsvpRoutes);

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: nowIso() }));

// ─── WebSocket Upgrade Route ──────────────────────────────────────

app.get('/api/setup/identity', async c => { c.header('Cache-Control','no-store'); return c.json({id:await setupIdentity(c.env)}); });

app.get('/api/ws', authMiddleware, async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ success: false, error: 'Expected a WebSocket upgrade' }, 426);
  }

  // WebSocket handshakes are exempt from CORS, so the Origin check has to be
  // explicit here or any site could open an authenticated socket.
  const origin = c.req.header('Origin');
  if (!isAllowedOrigin(origin, c.env)) {
    return c.json({ success: false, error: 'Origin not allowed' }, 403);
  }

  const userId = c.get('userId');
  const doId = c.env.WEBSOCKET_HUB.idFromName(userId);
  const doStub = c.env.WEBSOCKET_HUB.get(doId);

  // Forward the original request with a copy of ALL its headers, so the
  // Upgrade and Sec-WebSocket-* handshake headers survive; the path is kept
  // and the hub matches both /ws and /api/ws. Only the session headers are
  // replaced, from the authenticated session, overwriting any client value.
  const token = getCookie(c, 'session_token')!;
  const tag = await sessionTag(token);
  const headers = new Headers(c.req.raw.headers);
  headers.set(SESSION_TAG_HEADER, tag);
  headers.set(SESSION_EXPIRES_HEADER, c.get('sessionExpiresAt'));
  const response = await doStub.fetch(new Request(c.req.raw, { headers }));
  // A /revoke that ran between the session lookup above and this accept missed
  // the socket. Revokers delete the session before revoking, so re-check it.
  if (response.status === 101 && !(await c.env.DB.prepare('SELECT 1 FROM sessions WHERE token = ?').bind(tag).first())) {
    await revokeSockets(c.env, userId, [tag]);
  }
  return response;
});

// ─── Public Shared File Downloads (no auth) ──────────────────────

const UNSAFE_DOWNLOAD_TYPES = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml)/i;

app.get('/api/shared/:shareId', async (c) => {
  const shareId = c.req.param('shareId');

  const file = await c.env.DB.prepare(
    'SELECT id, filename, mime_type, size, r2_key FROM shared_files WHERE id = ? AND lifecycle != \'deleting\' AND NOT EXISTS (SELECT 1 FROM shared_uploads WHERE share_id = shared_files.id)'
  )
    .bind(shareId)
    .first<{ id: string; filename: string; mime_type: string; size: number; r2_key: string }>();

  if (!file) return c.json({ success: false, error: 'File not found' }, 404);

  const object = await c.env.EMAIL_BUCKET.get(file.r2_key);
  if (!object) return c.json({ success: false, error: 'File not found in storage' }, 404);

  const contentType = UNSAFE_DOWNLOAD_TYPES.test(file.mime_type)
    ? 'application/octet-stream'
    : file.mime_type || 'application/octet-stream';

  const asciiName = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.size),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ─── Protected Routes (require auth) ─────────────────────────────

const protectedApi = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
protectedApi.use('*', authMiddleware);
protectedApi.use('*', async (c, next) => {
  // This router is mounted at /api; admin routes must keep their control DB
  // even when the administrator migrates their own mailbox.
  if (/^\/api\/(emails|folders|search|attachments|forwarding)(?:\/|$)/.test(c.req.path)) c.env = await mailboxEnv(c.env, c.get('userId'));
  await next();
});

protectedApi.route('/protocol', protocolSettings);
protectedApi.route('/ai', aiRoutes);
protectedApi.route('/emails', emailRoutes);
protectedApi.route('/folders', folderRoutes);
protectedApi.route('/contacts', contactRoutes);
protectedApi.route('/calendar', calendarRoutes);
protectedApi.route('/search', searchRoutes);
protectedApi.route('/attachments', attachmentRoutes);
protectedApi.route('/forwarding', forwardingRoutes);

app.route('/api', protectedApi);

// ─── Admin Routes (require auth + admin role) ─────────────────────

const adminApi = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
adminApi.use('*', authMiddleware);
adminApi.use('*', adminMiddleware);
adminApi.route('/setup', setupRoutes);
adminApi.route('/', adminRoutes);
adminApi.route('/forwarding', forwardingAdminRoutes);
adminApi.route('/mailboxes', mailboxAdminRoutes);
adminApi.route('/protocol', protocolAdmin);
adminApi.route('/ai', aiAdminRoutes);

app.route('/api/admin', adminApi);

// ─── 404 Fallback ─────────────────────────────────────────────────

app.notFound((c) => c.json({ success: false, error: 'Not found' }, 404));

// ─── Error Handler ────────────────────────────────────────────────

app.onError((err, c) => {
  if (err instanceof MailboxReportPending) {
    c.header('Retry-After','60');
    return c.json({success:false,error:err.message},503);
  }
  if (err instanceof MailboxUnavailable || /Mailbox maintenance/.test(err.message)) {
    c.header('Retry-After', '30');
    return c.json({success:false,error:'Mailbox maintenance is in progress. Please retry shortly.'},503);
  }
  console.error('Unhandled error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

// ─── Worker Exports ───────────────────────────────────────────────

export default {
  /**
   * HTTP fetch handler — serves the Hono REST API.
   */
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, await setupBrowserEnv(env), ctx),

  /**
   * Email Routing handler — stages the raw message in R2 and enqueues a
   * pointer to it.
   *
   * The raw MIME never goes through the Queue: a Queue message is capped at
   * 128 KB, so base64-ing a whole email in there failed for anything with an
   * attachment. Streaming straight into R2 also keeps this handler O(1) in
   * CPU and memory, which matters against the 50 ms Email Worker budget.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Policy rejection: refuse oversize mail up front with a clear SMTP reason.
    if (message.rawSize > MAX_INBOUND_BYTES) {
      message.setReject(`Message exceeds the ${MAX_INBOUND_BYTES / (1024 * 1024)} MB limit`);
      return;
    }

    const rawKey = inboundRawKey(generateUUIDv7());

    // R2 refuses a stream of unknown length ("Provided readable stream must
    // have a known length"), and `message.raw` is exactly that — putting it
    // directly throws on every single inbound message. FixedLengthStream
    // declares the size up front, so the body still streams through without
    // ever being buffered whole.
    const sized = new FixedLengthStream(message.rawSize);
    const pumped = message.raw.pipeTo(sized.writable);

    // No try/catch around the infrastructure calls. If R2 or Queues fail this
    // must throw so Email Routing retries delivery — calling setReject() here
    // would turn a transient blip into a permanent bounce.
    await Promise.all([
      pumped,
      env.EMAIL_BUCKET.put(rawKey, sized.readable, {
        httpMetadata: { contentType: 'message/rfc822' },
        customMetadata: {
          envelopeFrom: message.from,
          envelopeTo: message.to,
          receivedAt: nowIso(),
        },
      }),
    ]);

    const queueMessage: InboundEmailMessage = {
      automated: message.headers.has('x-rwa-auto-forwarded') ||
        !!message.headers.get('list-id') || !!message.headers.get('list-unsubscribe') || /^(bulk|list|junk)$/i.test(message.headers.get('precedence') || '') ||
        (!!message.headers.get('auto-submitted') && message.headers.get('auto-submitted')!.trim().toLowerCase() !== 'no') || !message.from,
      rawKey,
      // Stable across redeliveries; the staging key is not.
      messageKey: message.headers.get('message-id') || undefined,
      from: message.from,
      to: message.to,
      rawSize: message.rawSize,
      receivedAt: nowIso(),
    };

    await env.EMAIL_QUEUE.send(queueMessage);
    console.log(`Inbound email staged: key=${rawKey} from=${message.from} to=${message.to}`);
  },

  /**
   * Queue consumer — processes batches of inbound emails.
   *
   * Each message is handled in its own try/catch: an uncaught throw would
   * retry the whole batch, replaying messages that already succeeded.
   */
  async queue(
    batch: MessageBatch<QueueJob>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    for (const message of batch.messages) {
      try {
        if ('kind' in message.body && message.body.kind === 'outbound') await processOutbound(message.body, env);
        else if ('kind' in message.body && message.body.kind === 'forwarding') await processForwarding(message.body, env);
        else await processInboundEmail(message.body as InboundEmailMessage, env);
        message.ack();
      } catch (err) {
        if (err instanceof MailboxUnavailable || (err instanceof Error && /Mailbox maintenance/.test(err.message))) {
          // Migration can outlast Queue's retry budget. Preserve the job with a
          // fresh delayed publication; acknowledge only after that succeeds.
          // Republishing resets attempts, so it is capped (~1 h) and then falls
          // through to retry() and the DLQ; a deleted owner's job is dropped.
          const body = message.body as QueueJob & { republishes?: number };
          try {
            if ('userId' in body && body.userId && !(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(body.userId).first())) {
              console.warn(`Dropping ${body.kind} job: user ${body.userId} no longer exists`);
              message.ack();
              continue;
            }
            if ((body.republishes || 0) < MAX_MAINTENANCE_REPUBLISHES) {
              const next = { ...body, republishes: (body.republishes || 0) + 1 };
              if ('kind' in next) await env.OUTBOUND_QUEUE.send(next,{delaySeconds:60});
              else await env.EMAIL_QUEUE.send(next,{delaySeconds:60});
              message.ack();
              continue;
            }
          } catch { /* retried below */ }
          message.retry({delaySeconds:60});
          continue;
        }
        console.error(`Failed to process inbound email (attempt ${message.attempts}):`, err);
        // Back off exponentially so a transient D1/R2 failure is not hammered.
        message.retry({ delaySeconds: Math.min(300, 10 * 2 ** Math.max(0, message.attempts - 1)) });
      }
    }
  },

  /**
   * Cron trigger. Every minute: deleted-account cleanup, mailbox provisioning
   * and calendar dispatch. Every 15 minutes: central cleanup and forwarding
   * snapshots. Outbox dispatch and retention run in MailboxDO alarms instead.
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Awaited, not ctx.waitUntil'd, and in order. Each step is isolated so one
    // failure is logged without skipping the steps after it.
    const steps = _event.cron === '* * * * *'
      ? [cleanupDeletedMailboxes, provisionMailboxes, dispatchCalendar, syncSubdomainRouting]
      : [runCentralCleanup, cleanupForwardingSnapshots];
    for (const step of steps) {
      try { await step(env); }
      catch (error) { console.error(`Scheduled step ${step.name} failed:`, error); }
    }
  },
};
