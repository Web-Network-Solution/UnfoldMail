import type { Context, Next } from 'hono';
import type { Env, HonoVariables } from '../types';
import { isAllowedOrigin } from '../lib/origin';

/**
 * Origin check for state-changing requests.
 *
 * `application/json` bodies are already CSRF-resistant: a cross-site form
 * cannot send that content type without a preflight, and the preflight is
 * refused by the CORS allowlist.
 *
 * `multipart/form-data` is NOT. It is one of the three content types a plain
 * HTML form can submit cross-site with no preflight at all, so the attachment
 * upload and the admin CSV import were reachable from any page the user
 * visited while logged in — including bulk-provisioning accounts. On a
 * split-origin deployment the session cookie is SameSite=None, which removes
 * the browser's own backstop entirely.
 *
 * This middleware rejects a mutating request whose Origin is present but not
 * recognised. A request with no Origin at all passes (see below).
 */
export async function csrfGuard(
  c: Context<{ Bindings: Env; Variables: HonoVariables }>,
  next: Next
) {
  const method = c.req.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }

  const origin = c.req.header('Origin');

  // A browser always sends Origin on a cross-origin mutating request. Its
  // absence means a same-origin non-browser client (curl, a health check),
  // which cannot be driven by an attacker's page.
  if (origin && !isAllowedOrigin(origin, c.env)) {
    return c.json({ success: false, error: 'Origin not allowed' }, 403);
  }

  await next();
}
