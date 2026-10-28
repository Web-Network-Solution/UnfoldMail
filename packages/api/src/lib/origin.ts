/**
 * Allowed browser origins.
 *
 * The API previously reflected whatever Origin the caller sent while also
 * setting `credentials: true`, which lets any website read authenticated
 * responses. The allowlist is derived from configuration instead.
 *
 * `APP_URL` is the deployed SPA origin. `EXTRA_ALLOWED_ORIGINS` is an optional
 * comma-separated list for preview deployments. Localhost dev origins are
 * accepted only when `ENVIRONMENT` is not "production".
 */
import type { Env } from '../types';

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
];

function normalize(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(env: Env): string[] {
  const origins = new Set<string>();

  const appOrigin = env.APP_URL ? normalize(env.APP_URL) : null;
  if (appOrigin) origins.add(appOrigin);

  for (const entry of (env.EXTRA_ALLOWED_ORIGINS || '').split(',')) {
    if (!entry.trim()) continue;
    const origin = normalize(entry);
    if (origin) origins.add(origin);
  }

  if (env.ENVIRONMENT !== 'production') {
    for (const origin of DEV_ORIGINS) origins.add(origin);
  }

  return [...origins];
}

export function isAllowedOrigin(origin: string | undefined | null, env: Env): boolean {
  // Same-origin requests (the SPA served from the Worker itself) and non-browser
  // clients send no Origin header at all.
  if (!origin) return true;
  return allowedOrigins(env).includes(origin);
}
