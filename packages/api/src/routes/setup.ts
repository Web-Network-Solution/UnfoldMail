import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import type { Env, HonoVariables } from "../types";
import {
  CloudflareSetup,
  SetupError,
  boundedJSON,
  inspectSetup,
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
type StoredPlan = { id: string; expires: number; plan: Plan };
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
async function client(env: Env) {
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
    !zones.some((z) => z.name.toLowerCase() === env.EMAIL_DOMAIN.toLowerCase())
  )
    throw new SetupError(
      "This token cannot access the EMAIL_DOMAIN configured for this installation.",
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
    data: zones
      .filter((z) => z.name.toLowerCase() === c.env.EMAIL_DOMAIN.toLowerCase())
      .map((z) => ({ id: z.id, name: z.name })),
  });
});
routes.get("/workers", async (c) => {
  const zoneId = c.req.query("zoneId") || "";
  if (!/^[a-f0-9]{32}$/.test(zoneId)) throw new SetupError("Select a domain.");
  const cf = await client(c.env);
  const zone = await cf.get<Zone>("/zones/" + zoneId);
  if (zone.name !== c.env.EMAIL_DOMAIN)
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
    const progress: string[] = JSON.parse(row.progress);
    if (!progress.length && stored.expires < Date.now())
      throw new SetupError("The plan expired. Review it again.", 409);
    if (progress.length === SETUP_STEPS.length)
      return c.json({ success: true, data: { done: true, progress } });
    const cf = await client(c.env);
    const fresh = await inspectSetup(
      cf,
      stored.plan.target,
      c.env.EMAIL_DOMAIN,
      await setupIdentity(c.env),
    );
    if (fresh.blockers.length)
      throw new SetupError(fresh.blockers.join(" "), 409);
    if (!progress.length && fresh.digest !== stored.plan.digest)
      throw new SetupError("Domain settings changed. Review a new plan.", 409);
    const step = SETUP_STEPS[progress.length];
    await performSetupStep(cf, fresh, step);
    if (step === "hostname" && fresh.target.webHostname)
      await c.env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('setup_web_origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
        .bind("https://" + fresh.target.webHostname)
        .run();
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
      data: { url: origin + "/connect?challenge=" + challenge },
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
    const res = await fetch(origin + "/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifier: p.verifier }),
      redirect: "error",
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
