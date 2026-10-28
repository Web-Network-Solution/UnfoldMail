import type { Env } from "../types";
import { randomSetupSecret } from "./setup-crypto";
import { SetupError } from "./setup-cloudflare";
export type SetupState = {
  credential: string | null;
  method: string | null;
  expires_at: number | null;
  plan: string | null;
  progress: string;
  oauth_pending: string | null;
};
export const setupKey = (env: Env) =>
  env.SETUP_ENCRYPTION_KEY || env.BOOTSTRAP_SECRET || "";
export async function setupIdentity(env: Env) {
  const existing = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='setup_identity'",
  ).first<{ value: string }>();
  if (existing) return existing.value;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO settings(key,value) VALUES('setup_identity',?)",
  )
    .bind(randomSetupSecret())
    .run();
  return (await env.DB.prepare(
    "SELECT value FROM settings WHERE key='setup_identity'",
  ).first<{ value: string }>())!.value;
}
export async function setupState(env: Env) {
  return (await env.DB.prepare(
    "SELECT * FROM setup_state WHERE id=1",
  ).first<SetupState>())!;
}
export async function withSetupLock<T>(
  env: Env,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = randomSetupSecret();
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE setup_state SET lock_id=?,lock_until=? WHERE id=1 AND lock_until<?",
  )
    .bind(lock, now + 120000, now)
    .run();
  if (!result.meta.changes)
    throw new SetupError(
      "Another setup operation is running. Wait and retry.",
      409,
    );
  try {
    return await operation();
  } finally {
    await env.DB.prepare(
      "UPDATE setup_state SET lock_id=NULL,lock_until=0 WHERE id=1 AND lock_id=?",
    )
      .bind(lock)
      .run();
  }
}
export function brokerOrigin(env: Env): string | null {
  try {
    const u = new URL(env.SETUP_OAUTH_BROKER_URL || "");
    return u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
      ? u.origin
      : null;
  } catch {
    return null;
  }
}
// Only a hostname successfully attached by the setup wizard may join CORS.
// Keep APP_URL canonical: background mail links remain valid at the original address.
export async function setupBrowserEnv(env: Env): Promise<Env> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='setup_web_origin'",
  ).first<{ value: string }>();
  if (!row) return env;
  const u = new URL(row.value);
  if (u.protocol !== "https:" || !u.hostname.endsWith("." + env.EMAIL_DOMAIN))
    return env;
  return {
    ...env,
    EXTRA_ALLOWED_ORIGINS: [env.EXTRA_ALLOWED_ORIGINS, u.origin]
      .filter(Boolean)
      .join(","),
  };
}
