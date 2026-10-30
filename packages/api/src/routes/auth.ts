import type { Database } from "../services/mailbox-storage";
import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import type { Env, HonoVariables } from '../types';
import {
  generateSessionToken,
  generateUUIDv7,
  hashPassword,
  isValidEmail,
  nowIso,
  revokeSockets,
  sessionTag,
  verifyPassword,
} from '../lib/utils';
import { mapUser, type UserRow } from '../lib/mappers';
import { allowedOrigins } from '../lib/origin';
import { authMiddleware, endSession } from '../middleware/auth';
import { mailboxEnv } from '../services/mailbox-storage';
import {
  LOGIN_ATTEMPT_WINDOW_MS,
  MAX_LOGIN_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  SESSION_TTL_SECONDS,
} from '@email-service/shared';

const auth = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

const SESSION_COOKIE = 'session_token';
const ORIGINAL_SESSION_COOKIE = 'original_session';

/**
 * Well-formed hash that no password verifies against. Used to spend the same
 * PBKDF2 time on an unknown address as on a real one, so response latency does
 * not reveal which addresses exist. Must keep the same iteration count as
 * hashPassword() for the timings to match.
 */
const DUMMY_PASSWORD_HASH = `100000:${'0'.repeat(32)}:${'0'.repeat(64)}`;

/**
 * Secure everywhere except a localhost dev origin.
 *
 * Fails closed: a missing or malformed APP_URL yields `true` rather than
 * throwing (an unparsable value used to take down /auth/login entirely) and
 * never silently downgrades a real deployment to a non-Secure cookie.
 */
function useSecureCookie(env: Env): boolean {
  if (env.ENVIRONMENT === 'production') return true;
  try {
    const { hostname } = new URL(env.APP_URL);
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]';
  } catch {
    return true;
  }
}

/**
 * SameSite for the session cookie.
 *
 * Strict is right for the default deployment, where the Worker serves the SPA
 * from its own origin. But SETUP.md, the CORS allowlist and VITE_API_BASE all
 * support a split-origin deployment, and a Strict cookie is never sent on a
 * cross-site XHR — so that documented setup could not authenticate at all.
 *
 * Same-origin keeps Strict (no CSRF surface). Split-origin needs None, which
 * the browser only honours together with Secure.
 */
function sameSiteFor(c: Parameters<typeof setCookie>[0], env: Env): 'Strict' | 'None' {
  try {
    const apiOrigin = new URL(c.req.url).origin;
    // Every origin the API is willing to serve, not just APP_URL — a preview
    // deployment listed in EXTRA_ALLOWED_ORIGINS passed CORS but then got a
    // Strict cookie the browser never sent back, so it could not authenticate.
    const appOrigins = allowedOrigins(env);
    if (appOrigins.length === 0) return 'Strict';
    return appOrigins.every((origin) => origin === apiOrigin) ? 'Strict' : 'None';
  } catch {
    return 'Strict';
  }
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string, env: Env) {
  const sameSite = sameSiteFor(c, env);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // SameSite=None is only honoured on a Secure cookie.
    secure: sameSite === 'None' ? true : useSecureCookie(env),
    sameSite,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Attributes must match the cookie that was set, or the browser keeps it. */
function clearCookie(c: Parameters<typeof setCookie>[0], name: string, env: Env) {
  const sameSite = sameSiteFor(c, env);
  deleteCookie(c, name, { path: '/', sameSite, secure: sameSite === 'None' ? true : useSecureCookie(env) });
}

/**
 * original_session is `${adminToken}.${sessionTag(impersonationToken)}`, bound
 * to the impersonation that created it (tokens are hex, so '.' is safe). An
 * old unbound value has no boundTo and is never restored. Cookies hold raw
 * tokens; D1 holds only their sessionTag (see endSession).
 */
function readOriginal(c: Parameters<typeof setCookie>[0]): { token: string; boundTo?: string } | null {
  const value = getCookie(c, ORIGINAL_SESSION_COOKIE);
  if (!value) return null;
  const [token, boundTo] = value.split('.');
  return { token, boundTo };
}

// ─── Login throttling ─────────────────────────────────────────────

async function isLockedOut(
  db: Database,
  email: string,
  limit: number = MAX_LOGIN_ATTEMPTS
): Promise<boolean> {
  const row = await db
    .prepare('SELECT failed_count, first_failed_at FROM login_attempts WHERE email = ?')
    .bind(email)
    .first<{ failed_count: number; first_failed_at: string }>();

  if (!row) return false;

  const windowStart = Date.parse(row.first_failed_at);
  if (!Number.isFinite(windowStart) || Date.now() - windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    await db.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();
    return false;
  }
  return row.failed_count >= limit;
}

/**
 * Per-IP counter, keyed in the same table under a reserved prefix that cannot
 * collide with a real address (isValidEmail rejects anything without an @).
 * The per-address limit alone let one client spray many accounts freely.
 */
function ipKey(ip: string): string {
  return 'ip:' + ip;
}

async function recordFailure(db: Database, email: string): Promise<void> {
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO login_attempts (email, failed_count, first_failed_at, last_failed_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         failed_count = failed_count + 1,
         last_failed_at = excluded.last_failed_at`
    )
    .bind(email, timestamp, timestamp)
    .run();
}

async function clearFailures(db: Database, email: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();
}

// ─── Bootstrap the first admin ────────────────────────────────────
// Creating a user requires an admin session, and a fresh deploy has no users,
// so the admin panel was unreachable forever. This endpoint closes that
// chicken-and-egg gap: it works exactly once, while the users table is empty,
// and 409s on every call after that.

auth.post('/bootstrap', async (c) => {
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
    count: number;
  }>();

  if ((existing?.count || 0) > 0) {
    return c.json({ success: false, error: 'Already initialized' }, 409);
  }

  if (!c.env.BOOTSTRAP_SECRET || c.env.BOOTSTRAP_SECRET.length < 32) {
    return c.json({ success: false, error: 'Configure BOOTSTRAP_SECRET before first setup' }, 503);
  }
  const attemptKey = 'bootstrap:' + (c.req.header('CF-Connecting-IP') || 'unknown');
  if (await isLockedOut(c.env.DB, attemptKey)) {
    return c.json({ success: false, error: 'Too many setup attempts. Try again later.' }, 429);
  }
  const body = await c.req.json().catch(() => null);
  const { email, displayName, password, bootstrapSecret } = body || {};
  if (typeof bootstrapSecret !== 'string' || bootstrapSecret.length > 512 ||
      await sessionTag(bootstrapSecret) !== await sessionTag(c.env.BOOTSTRAP_SECRET)) {
    await recordFailure(c.env.DB, attemptKey);
    return c.json({ success: false, error: 'Invalid installation secret' }, 403);
  }
  if (typeof email !== 'string' || typeof displayName !== 'string' ||
      typeof password !== 'string' || !displayName.trim()) {
    return c.json({ success: false, error: 'email, displayName and password are required' }, 400);
  }
  const domain = (c.env.EMAIL_DOMAIN || '').trim().toLowerCase();
  if (!isValidEmail('admin@' + domain)) {
    return c.json({ success: false, error: 'Configure EMAIL_DOMAIN before first setup' }, 503);
  }
  if (!email.trim().toLowerCase().endsWith('@' + domain)) {
    return c.json({ success: false, error: 'Use an address on the configured mail domain' }, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }

  const normalized = email.toLowerCase().trim();

  if (!isValidEmail(normalized)) {
    return c.json({ success: false, error: 'Invalid email address' }, 400);
  }

  const userId = generateUUIDv7();
  const timestamp = nowIso();

  // Atomic: the emptiness test is part of the INSERT, so two concurrent calls
  // cannot both pass a separate SELECT and each create an admin.
  const created = await c.env.DB.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, must_reset_password, created_at, updated_at)
     SELECT ?, ?, ?, ?, 'super_admin', 0, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM users)`
  )
    .bind(
      userId,
      normalized,
      displayName.trim(),
      await hashPassword(password),
      timestamp,
      timestamp
    )
    .run();

  if (!created.meta?.changes) {
    return c.json({ success: false, error: 'Already initialized' }, 409);
  }

  try {
    await mailboxEnv(c.env, userId);
  } catch (err) {
    // Keep the committed account: its durable provisioning marker is retried
    // by cron and on first mailbox access. Deleting it could race provisioning.
    console.error('Bootstrap failed while creating system folders:', err);
    return c.json({success:true,data:{id:userId,email:normalized,role:'super_admin'},message:'Account created. Mailbox initialization will retry automatically.'},201);
  }

  return c.json(
    { success: true, data: { id: userId, email: normalized, role: 'super_admin' } },
    201
  );
});

/** Lets the login screen offer first-run setup instead of an unusable form. */
auth.get('/needs-bootstrap', async (c) => {
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{
    count: number;
  }>();
  return c.json({ success: true, data: { needsBootstrap: (existing?.count || 0) === 0 } });
});

// ─── Login ────────────────────────────────────────────────────────

auth.post('/login', async (c) => {
  const { email, password } = await c.req
    .json<{ email?: string; password?: string }>()
    .catch(() => ({}) as { email?: string; password?: string });

  if (!email || !password) {
    return c.json({ success: false, error: 'Email and password are required' }, 400);
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Reject junk before it can create a throttle row. login_attempts is keyed
  // on caller-supplied text, so recording failures for arbitrary strings let
  // anyone grow the table without bound.
  if (!isValidEmail(normalizedEmail)) {
    return c.json({ success: false, error: 'Invalid email or password' }, 401);
  }

  const clientIp = c.req.header('CF-Connecting-IP') || '';

  if (
    (await isLockedOut(c.env.DB, normalizedEmail)) ||
    (clientIp && (await isLockedOut(c.env.DB, ipKey(clientIp), MAX_LOGIN_ATTEMPTS * 5)))
  ) {
    return c.json(
      { success: false, error: 'Too many failed attempts. Try again in 15 minutes.' },
      429
    );
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, display_name, password_hash, role, must_reset_password, signature_html, created_at, updated_at FROM users WHERE email = ?'
  )
    .bind(normalizedEmail)
    .first<UserRow & { password_hash: string }>();

  // Always run the KDF, even when the address is unknown. Short-circuiting
  // here made an unknown address answer in a few milliseconds while a real one
  // cost a full 100k-iteration PBKDF2 — a timing oracle that enumerates every
  // employee address.
  const valid = await verifyPassword(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);

  if (!user || !valid) {
    await recordFailure(c.env.DB, normalizedEmail);
    if (clientIp) await recordFailure(c.env.DB, ipKey(clientIp));
    return c.json({ success: false, error: 'Invalid email or password' }, 401);
  }

  // Only the per-address counter is cleared. The per-IP counter deliberately
  // survives: it is shared across every account, so clearing it on success let
  // an attacker reset their own budget by logging into one account they own
  // between bursts, making the IP limit unenforceable.
  await clearFailures(c.env.DB, normalizedEmail);

  const sessionToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  await c.env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(await sessionTag(sessionToken), user.id, expiresAt, nowIso())
    .run();

  // A super admin backup left by an impersonation that ended without
  // stop-impersonate must not pass to whoever signs in next on this browser.
  const original = readOriginal(c);
  if (original) {
    await endSession(c.env, original.token);
    clearCookie(c, ORIGINAL_SESSION_COOKIE, c.env);
  }

  setSessionCookie(c, sessionToken, c.env);

  return c.json({ success: true, data: { user: mapUser(user) } });
});

// ─── Logout ───────────────────────────────────────────────────────

// No authMiddleware: with a dead session_token it answered 401 before it could
// end the backup session or clear either cookie.
auth.post('/logout', async (c) => {
  const sessionToken = getCookie(c, SESSION_COOKIE);
  const original = readOriginal(c);

  if (sessionToken) await endSession(c.env, sessionToken);
  // Logging out mid-impersonation ends the super admin's own session too.
  if (original) await endSession(c.env, original.token);

  clearCookie(c, SESSION_COOKIE, c.env);
  clearCookie(c, ORIGINAL_SESSION_COOKIE, c.env);

  return c.json({ success: true, message: 'Logged out' });
});

// ─── Get Current User ─────────────────────────────────────────────

auth.get('/me', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id, email, display_name, role, must_reset_password, signature_html, created_at, updated_at FROM users WHERE id = ?'
  )
    .bind(c.get('userId'))
    .first<UserRow>();

  if (!user) return c.json({ success: false, error: 'User not found' }, 404);

  // Mapped, not raw: /auth/login and /auth/me previously returned different
  // shapes, so the client's user object changed on every page reload.
  return c.json({ success: true, data: { ...mapUser(user), mustResetPassword: c.get("mustResetPassword") } });
});

// ─── Reset Password ───────────────────────────────────────────────

auth.post('/reset-password', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const sessionToken = getCookie(c, SESSION_COOKIE);

  const { currentPassword, newPassword } = await c.req
    .json<{ currentPassword?: string; newPassword?: string }>()
    .catch(() => ({}) as { currentPassword?: string; newPassword?: string });

  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { success: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }

  const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(userId)
    .first<{ password_hash: string }>();

  if (!user) return c.json({ success: false, error: 'User not found' }, 404);

  if (!(await verifyPassword(currentPassword || '', user.password_hash))) {
    return c.json({ success: false, error: 'Current password is incorrect' }, 401);
  }

  if (await verifyPassword(newPassword, user.password_hash)) {
    return c.json({ success: false, error: 'New password must differ from the current one' }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, must_reset_password = 0, updated_at = ? WHERE id = ?'
    ).bind(await hashPassword(newPassword), nowIso(), userId),
    // Every other session is invalidated: a password change is how a user
    // responds to a suspected compromise, so a stolen session must not survive.
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(
      userId,
      await sessionTag(sessionToken || '')
    ),
  ]);
  // Sockets of the deleted sessions must close too; this tab reconnects.
  await revokeSockets(c.env, userId);

  return c.json({ success: true, message: 'Password updated' });
});

// ─── Update Signature ─────────────────────────────────────────────

auth.put('/signature', authMiddleware, async (c) => {
  // Rejected rather than defaulted: a default would silently clear the signature.
  const body = await c.req.json<{ signatureHtml?: unknown }>().catch(() => null);
  const signatureHtml = body?.signatureHtml ?? '';
  if (!body || typeof body !== 'object' || typeof signatureHtml !== 'string') {
    return c.json({ success: false, error: 'signatureHtml must be a string' }, 400);
  }

  await c.env.DB.prepare('UPDATE users SET signature_html = ?, updated_at = ? WHERE id = ?')
    .bind((signatureHtml || '').slice(0, 10_000), nowIso(), c.get('userId'))
    .run();

  return c.json({ success: true, message: 'Signature updated' });
});

// ─── Impersonate User (Super Admin Only) ──────────────────────────

auth.post('/impersonate', authMiddleware, async (c) => {
  if (c.get('userRole') !== 'super_admin') {
    return c.json({ success: false, error: 'Only super admins can impersonate users' }, 403);
  }

  const { targetUserId } = await c.req
    .json<{ targetUserId?: string }>()
    .catch(() => ({}) as { targetUserId?: string });

  if (!targetUserId) {
    return c.json({ success: false, error: 'targetUserId is required' }, 400);
  }

  if (targetUserId === c.get('userId')) {
    return c.json({ success: false, error: 'Cannot impersonate yourself' }, 400);
  }

  const target = await c.env.DB.prepare(
    'SELECT id, email, display_name, role FROM users WHERE id = ?'
  )
    .bind(targetUserId)
    .first<{ id: string; email: string; display_name: string; role: string }>();

  if (!target) {
    return c.json({ success: false, error: 'Target user not found' }, 404);
  }

  const originalToken = getCookie(c, SESSION_COOKIE)!;
  const previous = readOriginal(c);
  if (previous) {
    // Nesting would overwrite the real super admin's backup and orphan it.
    if (previous.boundTo === (await sessionTag(originalToken))) {
      return c.json({ success: false, error: 'Stop the current impersonation first' }, 400);
    }
    // A stale or unbound backup can never be restored; end it and go on.
    await endSession(c.env, previous.token);
  }

  // Create a session for the target user
  const newToken = generateSessionToken();
  const newTag = await sessionTag(newToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  await c.env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(newTag, target.id, expiresAt, nowIso())
    .run();

  // Save the current (super admin) session in a second httpOnly cookie, bound
  // to the new session so only stop-impersonate from that session restores it.
  const sameSite = sameSiteFor(c, c.env);
  setCookie(c, ORIGINAL_SESSION_COOKIE, `${originalToken}.${newTag}`, {
    httpOnly: true,
    secure: sameSite === 'None' ? true : useSecureCookie(c.env),
    sameSite,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });

  // Swap the session cookie to the target user
  setSessionCookie(c, newToken, c.env);

  return c.json({
    success: true,
    data: {
      targetEmail: target.email,
      targetDisplayName: target.display_name,
    },
  });
});

// ─── Stop Impersonation ───────────────────────────────────────────

auth.post('/stop-impersonate', authMiddleware, async (c) => {
  // Require the backup cookie — without it the caller is not impersonating.
  const original = readOriginal(c);
  if (!original) {
    return c.json({ success: false, error: 'Not currently impersonating' }, 400);
  }

  const currentToken = getCookie(c, SESSION_COOKIE)!;

  // Restore only the backup this session was created with, and only while it
  // is still valid, under a fresh token: the old one sat in a cookie all along.
  // Copied before the impersonated session ends, because a request that finds
  // it dead ends the bound backup (authMiddleware). Bound ISO time:
  // datetime('now') has a space where stored values have a 'T'.
  const fresh = generateSessionToken();
  const restored =
    original.boundTo === (await sessionTag(currentToken)) &&
    (await c.env.DB.prepare(
      'INSERT INTO sessions (token, user_id, expires_at, created_at) SELECT ?, user_id, expires_at, ? FROM sessions WHERE token = ? AND expires_at > ? RETURNING user_id'
    )
      .bind(await sessionTag(fresh), nowIso(), await sessionTag(original.token), nowIso())
      .first<{ user_id: string }>());

  // Restored: this same browser is moving to the admin session, so its sockets
  // get 4002 (reconnect) rather than 4001, which would sign other tabs out before
  // the new cookie reaches the jar.
  const code = restored ? 4002 : 4001;
  await endSession(c.env, currentToken, code);
  // The old backup token is never handed out again, restored or not.
  await endSession(c.env, original.token, code);

  if (restored) setSessionCookie(c, fresh, c.env);

  clearCookie(c, ORIGINAL_SESSION_COOKIE, c.env);

  return c.json({ success: true, message: 'Impersonation ended' });
});

export { auth as authRoutes };
