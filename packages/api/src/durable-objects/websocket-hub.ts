/**
 * WebSocket Hub — Durable Object
 *
 * One instance per user. Manages WebSocket connections using the Hibernation
 * API, so a connected-but-idle mailbox costs nothing while the tab sits open.
 * When a new email arrives, the email processor POSTs here and the payload is
 * broadcast to every live connection for that user.
 */
import { DurableObject } from 'cloudflare:workers';
import type { WsEvent } from '@email-service/shared';
import type { Env } from '../types';

/** Set by the Worker from the authenticated session; client values are overwritten. */
export const SESSION_TAG_HEADER = 'X-Session-Tag';
export const SESSION_EXPIRES_HEADER = 'X-Session-Expires';

export class WebSocketHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Answer client heartbeats in the runtime itself. Without this, every
    // ping wakes the object from hibernation, which defeats the point of
    // using the Hibernation API at all.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(JSON.stringify({ type: 'ping' }), JSON.stringify({ type: 'pong' }))
    );
  }

  /**
   * - GET  /ws     → WebSocket upgrade
   * - POST /notify → broadcast to connected clients
   * - POST /revoke {tags?} → close the sockets of those session tags, or all
   *
   * Reachable only through the Worker, which authenticates the caller first;
   * Durable Objects have no public route of their own.
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    // The Worker forwards the client's request with its path unchanged, so it
    // arrives as /api/ws rather than /ws. Accept both.
    if (pathname === '/ws' || pathname === '/api/ws') {
      return this.handleWebSocketUpgrade(request);
    }
    if (pathname === '/notify' && request.method === 'POST') return this.handleNotify(request);
    if (pathname === '/revoke' && request.method === 'POST') return this.handleRevoke(request);

    return new Response('Not found', { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // Auth is checked only at upgrade, so every socket carries its session:
    // the tag lets logout/password changes close it, the expiry bounds it.
    const tag = request.headers.get(SESSION_TAG_HEADER);
    const expiresAt = request.headers.get(SESSION_EXPIRES_HEADER);
    if (!tag || !expiresAt) return new Response('Missing session', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ expiresAt });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleRevoke(request: Request): Promise<Response> {
    const { tags, code } = (await request.json().catch(() => ({}))) as { tags?: string[]; code?: number };
    const sockets = Array.isArray(tags) ? tags.flatMap((tag) => this.ctx.getWebSockets(tag)) : this.ctx.getWebSockets();
    for (const ws of sockets) this.close(ws, code === 4002 ? 4002 : 4001);
    return Response.json({ closed: sockets.length });
  }

  /**
   * 4001 tells the client its session ended; it reconnects only if its cookie is still valid.
   * 4002: this browser switched sessions (Switch Back); it reconnects and never signs out.
   */
  private close(ws: WebSocket, code: 4001 | 4002 = 4001): void {
    try {
      ws.close(code, code === 4002 ? 'Session rotated' : 'Session ended');
    } catch {
      // Already closing.
    }
  }

  private async handleNotify(request: Request): Promise<Response> {
    const event = (await request.json()) as WsEvent;
    const payload = JSON.stringify(event);
    const sockets = this.ctx.getWebSockets();

    let delivered = 0;
    for (const ws of sockets) {
      // A socket without a live session (expired, or opened before sessions
      // were recorded) is closed rather than sent mail metadata.
      const { expiresAt } = (ws.deserializeAttachment() || {}) as { expiresAt?: string };
      if (!(Date.parse(expiresAt || '') > Date.now())) {
        this.close(ws);
        continue;
      }
      try {
        ws.send(payload);
        delivered++;
      } catch {
        // Socket is closing; the Hibernation API cleans it up.
      }
    }

    return Response.json({ delivered, total: sockets.length });
  }

  /**
   * Hibernation API: client → server message.
   * Plain pings are handled by the auto-response pair above and never reach here.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const data = JSON.parse(text) as { type?: string };
      if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      // Ignore malformed messages.
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    console.log(`WebSocket closed: code=${code}, reason=${reason}, clean=${wasClean}`);
    // Before web_socket_auto_reply_to_close (compat date 2026-04-07) the
    // runtime leaves the client's close half-open unless it is answered here.
    // 1005/1006 are reserved and cannot be sent.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed, e.g. the client answering our own 4001.
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
  }
}
