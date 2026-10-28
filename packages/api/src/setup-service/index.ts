import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import {
  randomSetupSecret,
  setupHash,
  sealSetup,
  openSetup,
} from "../services/setup-crypto";
import {
  CloudflareSetup,
  type Zone,
  boundedJSON,
} from "../services/setup-cloudflare";
export interface BrokerEnv {
  BROKER_DB: D1Database;
  BROKER_ORIGIN: string;
  BROKER_ENCRYPTION_KEY: string;
  OAUTH_CLIENT_ID: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_SCOPES: string;
}
type Flow = {
  installation: string;
  email_domain: string;
  state: string;
  challenge: string;
  verifier: string;
  expires: number;
};
export const broker = new Hono<{ Bindings: BrokerEnv }>();
broker.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  await next();
});
broker.use("*", bodyLimit({ maxSize: 2048 }));
broker.onError((_e, c) =>
  c.text(
    "Connection could not be completed. Return to UnfoldMail and start again.",
    500,
  ),
);
function configured(env: BrokerEnv) {
  try {
    const u = new URL(env.BROKER_ORIGIN);
    return (
      u.origin === env.BROKER_ORIGIN &&
      u.protocol === "https:" &&
      !!env.OAUTH_CLIENT_ID &&
      !!env.OAUTH_SCOPES &&
      env.BROKER_ENCRYPTION_KEY?.length >= 32
    );
  } catch {
    return false;
  }
}
broker.get("/", (c) =>
  c.html(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UnfoldMail Setup</title><body style="font:18px system-ui;max-width:40rem;margin:4rem auto;padding:1rem"><h1>UnfoldMail Setup</h1><p>An optional Cloudflare authorization service from <a href="https://webnetworksolution.com">Web Network Solutions</a>.</p><p>Start from Email setup in your own UnfoldMail installation. Paste API token is the primary method and does not send your token to this service.</p><p>If you choose OAuth, this service temporarily stores an encrypted authorization credential. Only your initiating installation can retrieve it, once. Unclaimed credentials expire within five minutes and are removed by scheduled cleanup. No refresh token is retained.</p><p><a href="https://github.com/Web-Network-Solution/UnfoldMail/tree/main/deployment/oauth">Source code and deployment instructions</a></p></body></html>',
  ),
);
broker.get("/status", (c) =>
  c.json({ available: configured(c.env), protocolVersion: 2 }),
);
broker.get("/connect", async (c) => {
  if (!configured(c.env))
    return c.text(
      "OAuth is not enabled. Use Paste API token in UnfoldMail.",
      503,
    );
  if (new URL(c.req.url).origin !== c.env.BROKER_ORIGIN)
    return c.text("Use the configured setup service address.", 400);
  const challenge = c.req.query("challenge") || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return c.text("Invalid connection request.", 400);
  const installation = c.req.query("installation") || "";
  const domain = c.req.query("domain") || "";
  try {
    const u = new URL(installation);
    if (
      u.origin !== installation ||
      u.protocol !== "https:" ||
      u.port ||
      u.username ||
      u.password ||
      !/^[a-z0-9.-]+$/.test(domain) ||
      !domain.includes(".") ||
      domain.length > 253
    )
      return c.text("Invalid installation address.", 400);
  } catch {
    return c.text("Invalid installation address.", 400);
  }
  // Bounded per-IP starts and bounded global live rows prevent unbounded anonymous storage.
  const now = Date.now();
  const ip = await setupHash(c.req.header("CF-Connecting-IP") || "unknown");
  const bucket = Math.floor(now / 600000);
  const rate = await c.env.BROKER_DB.prepare(
    "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(ip + ":" + bucket, now + 1200000)
    .first<{ count: number }>();
  if ((rate?.count || 0) > 10)
    return c.text("Too many attempts. Wait ten minutes.", 429);
  const count = await c.env.BROKER_DB.prepare(
    "SELECT COUNT(*) AS n FROM flows WHERE expires>?",
  )
    .bind(now)
    .first<{ n: number }>();
  if ((count?.n || 0) >= 1000)
    return c.text("Setup service is busy. Try again shortly.", 503);
  const state = randomSetupSecret();
  const verifier = randomSetupSecret();
  await c.env.BROKER_DB.prepare(
    "INSERT INTO flows(state,challenge,verifier,expires,installation,email_domain) VALUES(?,?,?,?,?,?)",
  )
    .bind(
      await setupHash(state),
      challenge,
      await sealSetup(c.env.BROKER_ENCRYPTION_KEY, verifier, "pkce"),
      now + 600000,
      installation,
      domain,
    )
    .run();
  setCookie(c, "__Host-unfoldmail-state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const auth = new URL("https://dash.cloudflare.com/oauth2/auth");
  auth.search = new URLSearchParams({
    client_id: c.env.OAUTH_CLIENT_ID,
    redirect_uri: c.env.BROKER_ORIGIN + "/callback",
    response_type: "code",
    scope: c.env.OAUTH_SCOPES,
    state,
    code_challenge: await setupHash(verifier),
    code_challenge_method: "S256",
  }).toString();
  return c.redirect(auth.toString());
});
broker.get("/callback", async (c) => {
  if (!configured(c.env) || new URL(c.req.url).origin !== c.env.BROKER_ORIGIN)
    return c.text("Service configuration is unavailable.", 503);
  const state = c.req.query("state") || "";
  const cookie = getCookie(c, "__Host-unfoldmail-state");
  if (!cookie || state !== cookie || !/^[A-Za-z0-9_-]{43}$/.test(state))
    return c.text(
      "The authorization session does not match. Start again.",
      400,
    );
  deleteCookie(c, "__Host-unfoldmail-state", { path: "/", secure: true });
  const flow = await c.env.BROKER_DB.prepare(
    "DELETE FROM flows WHERE state=? AND expires>? RETURNING *",
  )
    .bind(await setupHash(state), Date.now())
    .first<Flow>();
  if (!flow)
    return c.text(
      "This connection expired or was already used. Start again.",
      400,
    );
  const code = c.req.query("code");
  if (!code || code.length > 4096 || c.req.query("error"))
    return c.text(
      "Authorization was not completed. Return to UnfoldMail.",
      400,
    );
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: c.env.OAUTH_CLIENT_ID,
    redirect_uri: c.env.BROKER_ORIGIN + "/callback",
    code,
    code_verifier: await openSetup(
      c.env.BROKER_ENCRYPTION_KEY,
      flow.verifier,
      "pkce",
    ),
  });
  if (c.env.OAUTH_CLIENT_SECRET)
    params.set("client_secret", c.env.OAUTH_CLIENT_SECRET);
  const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return c.text(
      "Cloudflare did not authorize the connection. Start again.",
      400,
    );
  }
  const grant = await boundedJSON<{
    access_token: string;
    expires_in: number;
    token_type: string;
  }>(res);
  if (
    typeof grant.access_token !== "string" ||
    grant.access_token.length > 4096 ||
    grant.token_type?.toLowerCase() !== "bearer" ||
    !Number.isFinite(grant.expires_in) ||
    grant.expires_in <= 0
  )
    return c.text("Cloudflare returned an unsupported credential.", 502);
  // Resolve ownership using the authorized account, never by fetching a caller's URL.
  const cf = new CloudflareSetup(grant.access_token);
  const zones = await cf.list<Zone>(
    "/zones?name=" + encodeURIComponent(flow.email_domain),
  );
  const zone = zones.find(
    (z) => z.name === flow.email_domain && z.status === "active",
  );
  if (!zone || !/^[a-f0-9]{32}$/.test(zone.account.id))
    return c.text(
      "The installation domain is not in the authorized account.",
      403,
    );
  const hostname = new URL(flow.installation).hostname;
  let workerName = "";
  if (hostname.endsWith(".workers.dev")) {
    const sub = await cf.get<{ subdomain: string }>(
      "/accounts/" + zone.account.id + "/workers/subdomain",
    );
    const suffix = "." + sub.subdomain + ".workers.dev";
    if (hostname.endsWith(suffix))
      workerName = hostname.slice(0, -suffix.length);
  } else if (hostname === zone.name || hostname.endsWith("." + zone.name)) {
    const domains = await cf.list<{
      hostname: string;
      service: string;
      zone_id: string;
    }>("/accounts/" + zone.account.id + "/workers/domains");
    workerName =
      domains.find((d) => d.hostname === hostname && d.zone_id === zone.id)
        ?.service || "";
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(workerName))
    return c.text(
      "The installation is not a Worker in the authorized account.",
      403,
    );
  const settings = await cf.get<{ bindings?: { name: string }[] }>(
    "/accounts/" +
      zone.account.id +
      "/workers/scripts/" +
      encodeURIComponent(workerName) +
      "/settings",
  );
  if (
    !["DB", "MAILBOXES", "EMAIL_BUCKET"].every((name) =>
      settings.bindings?.some((b) => b.name === name),
    )
  )
    return c.text("The destination is not an UnfoldMail installation.", 403);
  const deliveryCode = randomSetupSecret();
  const expiresAt = Date.now() + Math.min(grant.expires_in, 86400) * 1000;
  const payload = await sealSetup(
    c.env.BROKER_ENCRYPTION_KEY,
    JSON.stringify({ token: grant.access_token, expiresAt }),
    "grant:" + flow.challenge,
  );
  await c.env.BROKER_DB.prepare(
    "INSERT INTO grants(challenge,payload,expires,delivery_hash) VALUES(?,?,?,?)",
  )
    .bind(
      flow.challenge,
      payload,
      Math.min(expiresAt, Date.now() + 300000),
      await setupHash(deliveryCode),
    )
    .run();
  // Only the authorizing browser receives this second capability. The initiator's
  // verifier alone cannot claim a victim's grant, even with an attacker-chosen link.
  return c.redirect(
    flow.installation + "/admin/setup#oauth_code=" + deliveryCode,
  );
});
broker.post("/claim", async (c) => {
  if (!configured(c.env)) return c.text("Unavailable", 503);
  const { verifier, code } = await c.req.json();
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code))
    return c.text("Invalid browser handoff", 400);
  if (typeof verifier !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(verifier))
    return c.text("Invalid request", 400);
  const challenge = await setupHash(verifier);
  const row = await c.env.BROKER_DB.prepare(
    "DELETE FROM grants WHERE challenge=? AND delivery_hash=? AND expires>? RETURNING payload",
  )
    .bind(challenge, await setupHash(code), Date.now())
    .first<{ payload: string }>();
  if (!row)
    return c.text(
      "Authorization is pending, expired, or already claimed.",
      409,
    );
  const payload = JSON.parse(
    await openSetup(
      c.env.BROKER_ENCRYPTION_KEY,
      row.payload,
      "grant:" + challenge,
    ),
  );
  return c.json(payload);
});
export default {
  fetch: broker.fetch,
  async scheduled(_event: ScheduledController, env: BrokerEnv) {
    const now = Date.now();
    await env.BROKER_DB.batch(
      ["flows", "grants", "rate_limits"].map((table) =>
        env.BROKER_DB.prepare(
          "DELETE FROM " + table + " WHERE expires<=?",
        ).bind(now),
      ),
    );
  },
};
