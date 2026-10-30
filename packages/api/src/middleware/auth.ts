import { verifiedSuperAdminSwitch } from "../services/session-switch";
import type { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Env, HonoVariables } from '../types';
import { revokeSockets, sessionTag } from '../lib/utils';

type Ctx = Context<{ Bindings: Env; Variables: HonoVariables }>;

/**
 * Endpoints a user with `must_reset_password` may still reach. Everything else
 * is blocked until the password is actually changed.
 */
const RESET_ALLOWED_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/reset-password',
  '/api/auth/stop-impersonate',
]);

/**
 * Ends a session the caller holds the token of: its D1 row and its sockets.
 * D1 keys sessions by sessionTag(token), never the bearer token itself, so a
 * leaked sessions table (backup, export, read-only bug) cannot be replayed.
 */
export async function endSession(env: Env, token: string, code: 4001 | 4002 = 4001): Promise<void> {
  const tag = await sessionTag(token);
  const row = await env.DB.prepare('DELETE FROM sessions WHERE token = ? RETURNING user_id')
    .bind(tag)
    .first<{ user_id: string }>();
  if (row) await revokeSockets(env, row.user_id, [tag], code);
}

/**
 * Authentication middleware.
 * Validates the session cookie against the sessions table in D1 and sets
 * userId, userEmail, userRole and mustResetPassword on the context.
 */
export async function authMiddleware(c: Ctx, next: Next) {
  // /api/admin/* passes through both the /api router and the admin router.
  // The first pass already validated the session and applied the reset gate.
  if (c.get('userId')) return next();

  const sessionToken = getCookie(c, 'session_token');

  if (!sessionToken) {
    return c.json({ success: false, error: 'Unauthorized — no session' }, 401);
  }

  const tag = await sessionTag(sessionToken);
  const session = await c.env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.role, u.must_reset_password
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  )
    .bind(tag)
    .first<{
      user_id: string;
      expires_at: string;
      email: string;
      role: string;
      must_reset_password: number;
    }>();

  // The 401s leave the cookie alone: a late 401 for an old session would
  // otherwise delete a newer cookie set meanwhile (e.g. stop-impersonate).
  if (!session) {
    // A dead impersonation leaves the super admin's token in original_session.
    // End the backup bound to this session. stop-impersonate restores under a
    // fresh token first, so a late request can only hit the old, ended backup.
    const [backup, boundTo] = (getCookie(c, 'original_session') ?? '').split('.');
    if (boundTo && boundTo === tag) await endSession(c.env, backup);
    return c.json({ success: false, error: 'Unauthorized — invalid session' }, 401);
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tag).run();
    return c.json({ success: false, error: 'Session expired' }, 401);
  }

  c.set('userId', session.user_id);
  c.set('userEmail', session.email);
  const role = session.role === 'super_admin' ? 'super_admin' : session.role === 'admin' ? 'admin' : 'employee';
  c.set('userRole', role);
  // Only a live, bound super-admin switch may bypass the employee reset gate.
  // The stored user flag is never cleared by switching.
  const mustReset = !!session.must_reset_password && !await verifiedSuperAdminSwitch(c);
  c.set('mustResetPassword', mustReset);
  c.set('sessionExpiresAt', session.expires_at);

  // Enforced here, not only in the UI. The login response already sets a live
  // session cookie, so a client that simply skipped the reset screen (or
  // called the API directly) previously had full access.
  if (mustReset && !RESET_ALLOWED_PATHS.has(new URL(c.req.url).pathname)) {
    return c.json(
      { success: false, error: 'Password reset required', code: 'PASSWORD_RESET_REQUIRED' },
      403
    );
  }

  await next();
}

/**
 * Admin-only guard. Must run AFTER authMiddleware.
 */
export async function adminMiddleware(c: Ctx, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin' && role !== 'super_admin') {
    return c.json({ success: false, error: 'Forbidden — admin access required' }, 403);
  }
  await next();
}
