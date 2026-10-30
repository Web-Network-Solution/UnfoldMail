import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { Env, HonoVariables } from "../types";
import {
  CloudflareSetup,
  domainInZone,
  matchingZones,
  isSubdomainPlan,
  SetupError,
  boundedJSON,
  inspectSetup,
  reconcileSetup,
  performSetupStep,
  validTarget,
  SETUP_STEPS,
  type Plan,
  type Zone,
} from "../services/setup-cloudflare";
import {
  openSetup,
  sealSetup,
  randomSetupSecret,
  setupHash,
} from "../services/setup-crypto";
import {
  setupState,
  setupIdentity,
  setupKey,
  withSetupLock,
  brokerOrigin,
} from "../services/setup-state";
type StoredPlan = {
  id: string;
  expires: number;
  plan: Plan;
  attemptedStep?: string;
};
async function setupRecipients(env: Env) {
  const rows = await env.DB.prepare("SELECT email FROM users ORDER BY email").all<{email: string}>();
  return rows.results.map(r => r.email);
}
const routes = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
routes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.get("userRole") !== "super_admin" || getCookie(c, "original_session"))
    return c.json(
      {
        success: false,
        error:
          "Sign in directly as a super administrator to configure this installation.",
      },
      403,
    );
  await next();
});
routes.use("*", bodyLimit({ maxSize: 8192 }));
routes.onError((e, c) =>
  c.json(
    {
      success: false,
      error:
        e instanceof SetupError
          ? e.message
          : "Setup could not be completed. Check the encryption secret and retry.",
    },
    (e instanceof SetupError ? e.status : 500) as 400,
  ),
);
export async function client(env: Env) {
  const row = await setupState(env);
  if (!row.credential)
    throw new SetupError("Connect your Cloudflare account first.");
  if (row.expires_at && row.expires_at <= Date.now())
    throw new SetupError("Your connection expired. Connect again.");
  return new CloudflareSetup(
    await openSetup(setupKey(env), row.credential, "cloudflare-token"),
  );
}
async function saveToken(
  env: Env,
  token: string,
  method: string,
  expires: number | null,
) {
  if (!token || token.length > 4096 || /\s/.test(token))
    throw new SetupError("Enter a valid API token.");
  const cf = new CloudflareSetup(token);
  const zones = await cf.list<Zone>("/zones");
  if (
    !matchingZones(zones, env.EMAIL_DOMAIN).length
  )
    throw new SetupError(
      "This token cannot access the Cloudflare zone containing EMAIL_DOMAIN. For mail.example.com, grant Zone Read access to example.com.",
    );
  const encrypted = await sealSetup(setupKey(env), token, "cloudflare-token");
  await env.DB.prepare(
    "UPDATE setup_state SET credential=?,method=?,expires_at=?,plan=NULL,progress='[]',oauth_pending=NULL WHERE id=1",
  )
    .bind(encrypted, method, expires)
    .run();
}
routes.get("/", async (c) => {
  const row = await setupState(c.env);
  return c.json({
    success: true,
    data: {
      routingStatus: (await c.env.DB.prepare("SELECT value FROM settings WHERE key='setup_routing_status'").first<{value: string}>())?.value || null,
      connected:
        !!row.credential && (!row.expires_at || row.expires_at > Date.now()),
      method: row.method,
      expiresAt: row.expires_at,
      domain: c.env.EMAIL_DOMAIN,
      oauthAvailable: !!brokerOrigin(c.env),
      progress: JSON.parse(row.progress),
      plan: row.plan ? JSON.parse(row.plan) : null,
    },
  });
});
routes.post("/token", (c) =>
  withSetupLock(c.env, async () => {
    const body = await c.req.json();
    if (typeof body.token !== "string")
      throw new SetupError("Enter an API token.");
    await saveToken(c.env, body.token.trim(), "token", null);
    return c.json({ success: true });
  }),
);
routes.delete("/connection", (c) =>
  withSetupLock(c.env, async () => {
    await c.env.DB.prepare(
      "UPDATE setup_state SET credential=NULL,method=NULL,expires_at=NULL,plan=NULL,progress='[]',oauth_pending=NULL WHERE id=1",
    ).run();
    return c.json({ success: true });
  }),
);
routes.get("/zones", async (c) => {
  const cf = await client(c.env);
  const zones = await cf.list<Zone>("/zones");
  return c.json({
    success: true,
    data: matchingZones(zones, c.env.EMAIL_DOMAIN)
      .map((z) => ({ id: z.id, name: z.name })),
  });
});
routes.get("/workers", async (c) => {
  const zoneId = c.req.query("zoneId") || "";
  if (!/^[a-f0-9]{32}$/.test(zoneId)) throw new SetupError("Select a domain.");
  const cf = await client(c.env);
  const zone = await cf.get<Zone>("/zones/" + zoneId);
  if (!domainInZone(c.env.EMAIL_DOMAIN, zone.name))
    throw new SetupError("Choose the installation domain.");
  const workers = await cf.list<{ id: string }>(
    "/accounts/" + zone.account.id + "/workers/scripts",
  );
  return c.json({ success: true, data: workers.map((w) => ({ id: w.id })) });
});
routes.post("/plan", (c) =>
  withSetupLock(c.env, async () => {
    const target = validTarget(await c.req.json());
    const cf = await client(c.env);
    const plan = await inspectSetup(
      cf,
      target,
      c.env.EMAIL_DOMAIN,
      await setupIdentity(c.env),
      await setupRecipients(c.env),
    );
    const stored: StoredPlan = {
      id: randomSetupSecret(),
      expires: Date.now() + 600000,
      plan,
    };
    await c.env.DB.prepare(
      "UPDATE setup_state SET plan=?,progress='[]' WHERE id=1",
    )
      .bind(JSON.stringify(stored))
      .run();
    return c.json({ success: true, data: stored });
  }),
);
routes.post("/apply", (c) =>
  withSetupLock(c.env, async () => {
    const body = await c.req.json();
    const row = await setupState(c.env);
    const stored: StoredPlan | null = row.plan ? JSON.parse(row.plan) : null;
    if (!stored || stored.id !== body.planId)
      throw new SetupError("Review the setup plan first.", 409);
    if (!stored.plan.snapshot)
      throw new SetupError("Review a new setup plan after upgrading.", 409);
    const progress: string[] = JSON.parse(row.progress);
    if (
      !progress.length &&
      !stored.attemptedStep &&
      stored.expires < Date.now()
    )
      throw new SetupError("The plan expired. Review it again.", 409);
    if (progress.length === SETUP_STEPS.length)
      return c.json({ success: true, data: { done: true, progress } });
    const cf = await client(c.env);
    const fresh = await inspectSetup(
      cf,
      stored.plan.target,
      c.env.EMAIL_DOMAIN,
      await setupIdentity(c.env),
      await setupRecipients(c.env),
    );
    if (fresh.blockers.length)
      throw new SetupError(fresh.blockers.join(" "), 409);
    if (fresh.digest !== stored.plan.digest) {
      if (!stored.attemptedStep)
        throw new SetupError(
          "Domain settings changed. Review a new plan.",
          409,
        );
      await reconcileSetup(cf, stored.plan, fresh, stored.attemptedStep);
    }
    const step = SETUP_STEPS[progress.length];
    // Write intent before any remote mutation. A retry reconciles only this step's changes.
    stored.plan = fresh;
    stored.attemptedStep = step;
    await c.env.DB.prepare("UPDATE setup_state SET plan=? WHERE id=1")
      .bind(JSON.stringify(stored))
      .run();
    const complete = await performSetupStep(cf, fresh, step);
    if (complete === false) return c.json({success: true, data: {done: false, progress}});
    if (step === "hostname" && fresh.target.webHostname)
      await c.env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('setup_web_origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
        .bind("https://" + fresh.target.webHostname)
        .run();
    if (step === "verification" && isSubdomainPlan(fresh)) {
      await c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('setup_routing_target',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(JSON.stringify({target: fresh.target, domain: fresh.domain, zoneName: fresh.zoneName, identity: fresh.identity})).run();
    }
    if (step === "hostname" && fresh.target.webHostname && fresh.zoneName)
      await c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('setup_web_zone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(fresh.zoneName).run();
    progress.push(step);
    await c.env.DB.prepare("UPDATE setup_state SET progress=? WHERE id=1")
      .bind(JSON.stringify(progress))
      .run();
    return c.json({
      success: true,
      data: { done: progress.length === SETUP_STEPS.length, progress },
    });
  }),
);
routes.post("/oauth/start", (c) =>
  withSetupLock(c.env, async () => {
    const origin = brokerOrigin(c.env);
    if (!origin)
      throw new SetupError(
        "Optional OAuth is not configured. Use an API token.",
      );
    const statusResponse = await fetch(origin + "/status", {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const service = await boundedJSON<{
      available: boolean;
      protocolVersion: number;
    }>(statusResponse);
    if (
      !statusResponse.ok ||
      !service.available ||
      service.protocolVersion !== 2
    )
      throw new SetupError(
        "Update and configure the optional OAuth service, or use an API token.",
      );
    const installation = new URL(c.req.url).origin;
    if (!installation.startsWith("https://"))
      throw new SetupError("OAuth requires HTTPS.");
    const verifier = randomSetupSecret();
    const challenge = await setupHash(verifier);
    const pending = {
      verifier,
      expires: Date.now() + 600000,
      user: c.get("userId"),
      session: await setupHash(getCookie(c, "session_token") || ""),
    };
    await c.env.DB.prepare("UPDATE setup_state SET oauth_pending=? WHERE id=1")
      .bind(
        await sealSetup(
          setupKey(c.env),
          JSON.stringify(pending),
          "oauth-pending",
        ),
      )
      .run();
    return c.json({
      success: true,
      data: {
        url:
          origin +
          "/connect?" +
          new URLSearchParams({
            challenge,
            installation,
            domain: c.env.EMAIL_DOMAIN,
          }).toString(),
      },
    });
  }),
);
routes.post("/oauth/finish", (c) =>
  withSetupLock(c.env, async () => {
    const origin = brokerOrigin(c.env);
    const row = await setupState(c.env);
    if (!origin || !row.oauth_pending)
      throw new SetupError("Start the Cloudflare connection first.");
    const p = JSON.parse(
      await openSetup(setupKey(c.env), row.oauth_pending, "oauth-pending"),
    );
    if (
      p.expires < Date.now() ||
      p.user !== c.get("userId") ||
      p.session !== (await setupHash(getCookie(c, "session_token") || ""))
    )
      throw new SetupError("Connection expired. Start again.");
    const body = await c.req.json();
    if (typeof body.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.code))
      throw new SetupError(
        "Complete authorization in the Cloudflare tab first.",
      );
    const res = await fetch(origin + "/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifier: p.verifier, code: body.code }),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok)
      throw new SetupError(
        "Complete authorization in the Cloudflare tab, then try again. If it expired, start again.",
      );
    const grant = await boundedJSON<{ token: string; expiresAt: number }>(res);
    if (
      typeof grant.token !== "string" ||
      !Number.isFinite(grant.expiresAt) ||
      grant.expiresAt <= Date.now()
    )
      throw new SetupError("OAuth authorization expired. Start again.");
    await saveToken(c.env, grant.token, "oauth", grant.expiresAt);
    return c.json({ success: true });
  }),
);
export default routes;
