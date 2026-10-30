import { syncSubdomainRouting } from "../src/services/setup-routing";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testDatabase } from "./helpers/database";
import routes from "../src/routes/setup";
import { csrfGuard } from "../src/middleware/csrf";
import { openSetup, sealSetup, setupHash } from "../src/services/setup-crypto";
import {
  setupIdentity,
  setupBrowserEnv,
  withSetupLock,
} from "../src/services/setup-state";
import {
  CloudflareSetup,
  inspectSetup,
  performSetupStep,
  domainInZone,
  matchingZones,
  expectedDNS,
  routingAddresses,
} from "../src/services/setup-cloudflare";
import { broker, type BrokerEnv } from "../src/setup-service";
import type { Env, HonoVariables } from "../src/types";
const zoneId = "a".repeat(32),
  accountId = "b".repeat(32),
  token = "test-secret-token";
function fixture(role = "super_admin") {
  const f = testDatabase(true);
  f.sqlite.exec(
    readFileSync(
      join(__dirname, "../../../deployment/migrations/0005_setup.sql"),
      "utf8",
    ),
  );
  const env = {
    DB: f.db,
    EMAIL_DOMAIN: "example.com",
    APP_URL: "https://mail.example.com",
    ENVIRONMENT: "production",
    BOOTSTRAP_SECRET: "k".repeat(64),
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => {
    c.set("userRole", role as HonoVariables["userRole"]);
    c.set("userId", "owner");
    await next();
  });
  app.use("*", csrfGuard);
  app.route("/setup", routes);
  const call = (
    path = "",
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(
      "https://mail.example.com/setup" + path,
      {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { ...f, env, call };
}
const senderTag = "c".repeat(32);
const sendingDNS = [
  {
    id: "send",
    type: "TXT",
    name: "cf-bounce.example.com",
    content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
  },
];
const receivingDNS = [
  {
    id: "receive",
    type: "MX",
    name: "example.com",
    content: "route1.mx.cloudflare.net",
    priority: 10,
  },
];
let domains: { hostname: string; service: string; zone_id: string }[];
let loseResponse: string;
let mailDomain: string;
let addressRules: any[];
const mailDNS = (rows: typeof sendingDNS) => rows.map(r => ({...r, name: r.name.replace("example.com", mailDomain)}));
let records: {
    id: string;
    type: string;
    name: string;
    content: string;
    priority?: number;
  }[],
  rule: unknown,
  failRouting: boolean,
  identity: string,
  writes: string[],
  sendingEnabled: boolean;
function network() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/status"))
      return Response.json({ available: true, protocolVersion: 2 });
    if (url.startsWith("https://cloudflare-dns.com/")) {
      const q = new URL(url).searchParams;
      return Response.json({
        Status: 0,
        Answer: records
          .filter((r) => r.name === q.get("name") && r.type === q.get("type"))
          .map((r) => ({
            name: r.name,
            type: r.type === "MX" ? 15 : 16,
            data:
              r.type === "MX"
                ? r.priority + " " + r.content
                : '"' + r.content + '"',
          })),
      });
    }
    if (
      url.includes("workers.dev") ||
      url.startsWith("https://mail.example.com/api/setup/identity")
    )
      return Response.json({ id: identity });
    const p = new URL(url).pathname.replace("/client/v4", "");
    const method = init?.method || "GET";
    if (method !== "GET") {
      writes.push(method + " " + p);
      if (p.endsWith("/catch_all") && failRouting)
        return new Response("", { status: 503 });
      if (method === "DELETE" && /\/dns_records\/[a-f0-9]{32}$/.test(p)) records = records.filter(r => r.id !== p.split("/").pop());
      if (p.endsWith("/catch_all")) rule = JSON.parse(String(init?.body));
      if (p.endsWith("/subdomains")) {
        sendingEnabled = true;
        records.push(...mailDNS(sendingDNS));
      }
      if (p.endsWith("/routing/dns")) records.push(...mailDNS(receivingDNS));
      if (p.endsWith("/routing/rules")) addressRules.push({...JSON.parse(String(init?.body)), id: (addressRules.length + 1).toString(16).padStart(32, "0")});
      if (method === "PUT" && /\/routing\/rules\/[a-f0-9]{32}$/.test(p)) {
        const id = p.split("/").pop();
        addressRules = addressRules.map(r => (r.id || r.tag) === id ? {...JSON.parse(String(init?.body)), id} : r);
      }
      if (p.endsWith("/workers/domains"))
        domains.push(JSON.parse(String(init?.body)));
      if (loseResponse && p.endsWith(loseResponse)) {
        loseResponse = "";
        throw Error("lost after commit");
      }
      return Response.json({ success: true, result: {} });
    }
    let result: unknown = [];
    if (p === "/zones")
      result = [
        {
          id: zoneId,
          name: "example.com",
          status: "active",
          account: { id: accountId },
        },
      ];
    else if (p === "/zones/" + zoneId)
      result = {
        id: zoneId,
        name: "example.com",
        status: "active",
        account: { id: accountId },
      };
    else if (p.endsWith("/settings"))
      result = {
        bindings: ["DB", "MAILBOXES", "EMAIL_BUCKET"].map((name) => ({ name })),
      };
    else if (p.endsWith("/workers/subdomain"))
      result = { subdomain: "account" };
    else if (p.endsWith("/workers/domains")) result = domains;
    else if (p.endsWith("/routing/dns")) result = mailDNS(receivingDNS);
    else if (p.endsWith("/" + senderTag + "/dns")) result = mailDNS(sendingDNS);
    else if (p.endsWith("/dns_records")) result = records;
    else if (p.endsWith("/routing/rules")) result = addressRules;
    else if (p.endsWith("/catch_all")) result = rule;
    else if (p.endsWith("/email/routing")) result = { enabled: true };
    else if (p.endsWith("/email/sending/subdomains"))
      result = [
        { name: mailDomain, enabled: sendingEnabled, tag: senderTag },
      ];
    return Response.json({ success: true, result });
  });
}
beforeEach(() => {
  mailDomain = "example.com";
  addressRules = [];
  records = [];
  domains = [];
  loseResponse = "";
  sendingEnabled = false;
  rule = { enabled: false };
  failRouting = false;
  identity = "installation";
  writes = [];
  vi.stubGlobal("fetch", network());
});
afterEach(() => vi.unstubAllGlobals());
describe("credential protection", () => {
  it("encrypts with a fresh IV and rejects wrong keys, contexts and altered ciphertext", async () => {
    const a = await sealSetup("a".repeat(32), token, "token"),
      b = await sealSetup("a".repeat(32), token, "token");
    expect(a).not.toBe(b);
    expect(a).not.toContain(token);
    expect(await openSetup("a".repeat(32), a, "token")).toBe(token);
    await expect(openSetup("b".repeat(32), a, "token")).rejects.toThrow();
    await expect(openSetup("a".repeat(32), a, "pending")).rejects.toThrow();
    await expect(
      openSetup("a".repeat(32), a.slice(0, -4) + "AAAA", "token"),
    ).rejects.toThrow();
    await expect(sealSetup("short", token, "token")).rejects.toThrow();
  });
  it.each(["employee", "admin"])(
    "rejects %s before accepting credentials",
    async (role) => {
      const f = fixture(role);
      expect((await f.call("/token", "POST", { token })).status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
      f.sqlite.close();
    },
  );
  it("rejects impersonation and cross-site writes", async () => {
    const f = fixture();
    expect(
      (
        await f.call(
          "/token",
          "POST",
          { token },
          { Cookie: "original_session=backup" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call(
          "/token",
          "POST",
          { token },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    f.sqlite.close();
  });
  it("never returns a stored token and removes it without touching cloud resources", async () => {
    const f = fixture();
    expect((await f.call("/token", "POST", { token })).status).toBe(200);
    const row = f.sqlite.prepare("SELECT credential FROM setup_state").get();
    expect(String(row?.credential)).not.toContain(token);
    expect(await (await f.call()).text()).not.toContain(token);
    await f.call("/connection", "DELETE");
    expect(
      f.sqlite.prepare("SELECT credential FROM setup_state").get()?.credential,
    ).toBeNull();
    expect(writes).toEqual([]);
    f.sqlite.close();
  });
  it("serializes mutating operations and releases the lock after failure", async () => {
    const f = fixture();
    await withSetupLock(f.env, async () => {
      await expect(withSetupLock(f.env, async () => {})).rejects.toThrow(
        "running",
      );
    });
    await expect(
      withSetupLock(f.env, async () => {
        throw Error("failure");
      }),
    ).rejects.toThrow();
    await expect(withSetupLock(f.env, async () => 42)).resolves.toBe(42);
    f.sqlite.close();
  });
  it("keeps identity stable and permits only configured same-domain web origins", async () => {
    const f = fixture();
    expect(await setupIdentity(f.env)).toBe(await setupIdentity(f.env));
    f.sqlite.exec(
      "INSERT INTO settings VALUES('setup_web_origin','https://web.example.com')",
    );
    expect((await setupBrowserEnv(f.env)).EXTRA_ALLOWED_ORIGINS).toBe(
      "https://web.example.com",
    );
    f.sqlite.exec(
      "UPDATE settings SET value='https://evil.example' WHERE key='setup_web_origin'",
    );
    expect(
      (await setupBrowserEnv(f.env)).EXTRA_ALLOWED_ORIGINS,
    ).toBeUndefined();
    f.sqlite.close();
  });
});
describe("reviewed provisioning", () => {
  const target = { zoneId, workerName: "unfoldmail", webHostname: "" };
  it("blocks an existing provider without performing any writes", async () => {
    records = [
      {
        id: "mx",
        type: "MX",
        name: "example.com",
        content: "mail.other.example",
      },
    ];
    const plan = await inspectSetup(
      new CloudflareSetup(token),
      target,
      "example.com",
      identity,
    );
    expect(plan.blockers.join()).toContain("existing mail provider");
    expect(writes).toEqual([]);
  });
  it("rejects a different Worker installation", async () => {
    await expect(
      inspectSetup(
        new CloudflareSetup(token),
        target,
        "example.com",
        "different",
      ),
    ).rejects.toThrow("different installation");
    expect(writes).toEqual([]);
  });
  it("blocks a conflicting catch-all and webmail DNS record", async () => {
    rule = {
      enabled: true,
      actions: [{ type: "forward", value: ["other@example.com"] }],
    };
    records = [
      { id: "a", type: "A", name: "mail.example.com", content: "192.0.2.1" },
    ];
    const p = await inspectSetup(
      new CloudflareSetup(token),
      { ...target, webHostname: "mail.example.com" },
      "example.com",
      identity,
    );
    expect(p.blockers).toHaveLength(2);
  });
  it("requires a new review when DNS changes after preview", async () => {
    const f = fixture();
    identity = await setupIdentity(f.env);
    await f.call("/token", "POST", { token });
    const p = (await (await f.call("/plan", "POST", target)).json()) as any;
    records.push({
      id: "txt",
      type: "TXT",
      name: "example.com",
      content: "new-record",
    });
    expect((await f.call("/apply", "POST", { planId: p.data.id })).status).toBe(
      409,
    );
    expect(writes).toEqual([]);
    f.sqlite.close();
  });
  it("resumes the failed step and does not repeat completed steps", async () => {
    const f = fixture();
    identity = await setupIdentity(f.env);
    await f.call("/token", "POST", { token });
    const p = (await (await f.call("/plan", "POST", target)).json()) as any;
    const apply = () => f.call("/apply", "POST", { planId: p.data.id });
    expect((await apply()).status).toBe(200);
    expect((await apply()).status).toBe(200);
    failRouting = true;
    expect((await apply()).status).toBe(502);
    expect(
      JSON.parse(
        String(
          f.sqlite.prepare("SELECT progress FROM setup_state").get()?.progress,
        ),
      ),
    ).toEqual(["sending", "receiving"]);
    failRouting = false;
    for (let n = 0; n < 3; n++) expect((await apply()).status).toBe(200);
    expect(writes.filter((w) => w.endsWith("/subdomains"))).toHaveLength(1);
    expect(((await (await apply()).json()) as any).data.done).toBe(true);
    f.sqlite.close();
  });
  it("rejects expired plans before writes", async () => {
    const f = fixture();
    identity = await setupIdentity(f.env);
    await f.call("/token", "POST", { token });
    const p = (await (await f.call("/plan", "POST", target)).json()) as any;
    p.data.expires = 0;
    f.sqlite
      .prepare("UPDATE setup_state SET plan=?")
      .run(JSON.stringify(p.data));
    expect((await f.call("/apply", "POST", { planId: p.data.id })).status).toBe(
      409,
    );
    expect(writes).toEqual([]);
    f.sqlite.close();
  });
  it("reads all routing pages before considering the domain safe", async () => {
    const base = network();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (i: RequestInfo | URL, o?: RequestInit) => {
        const u = new URL(String(i));
        if (u.pathname.endsWith("/routing/rules"))
          return Response.json({
            success: true,
            result:
              u.searchParams.get("page") === "1"
                ? []
                : [{ enabled: true, actions: [{ type: "drop" }] }],
            result_info: { total_pages: 2 },
          });
        return base(i, o);
      }),
    );
    const p = await inspectSetup(
      new CloudflareSetup(token),
      target,
      "example.com",
      identity,
    );
    expect(p.blockers.join()).toContain("address-specific");
  });
});
function brokerFixture() {
  const f = testDatabase(true);
  f.sqlite.exec(
    readFileSync(
      join(__dirname, "../../../deployment/oauth/migrations/0001_broker.sql"),
      "utf8",
    ),
  );
  f.sqlite.exec(
    readFileSync(
      join(
        __dirname,
        "../../../deployment/oauth/migrations/0002_browser_handoff.sql",
      ),
      "utf8",
    ),
  );
  const env: BrokerEnv = {
    BROKER_DB: f.db,
    BROKER_ORIGIN: "https://setup.example.com",
    BROKER_ENCRYPTION_KEY: "b".repeat(32),
    OAUTH_CLIENT_ID: "client",
    OAUTH_SCOPES: "configured:scope",
  };
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
  ) =>
    broker.request(
      env.BROKER_ORIGIN + path,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { ...f, env, call };
}
describe("optional OAuth handoff", () => {
  it("is disabled unless configured", async () => {
    const f = brokerFixture();
    f.env.OAUTH_CLIENT_ID = "";
    expect((await f.call("/connect?challenge=" + "a".repeat(43))).status).toBe(
      503,
    );
    f.sqlite.close();
  });
  it("requires the browser state cookie before exchanging a code", async () => {
    const f = brokerFixture();
    expect(
      (await f.call("/callback?state=" + "a".repeat(43) + "&code=code")).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    f.sqlite.close();
  });
  it("uses PKCE, exchanges once, and allows only the initiating verifier to claim once", async () => {
    const f = brokerFixture(),
      verifier = "a".repeat(43),
      challenge = await setupHash(verifier);
    const start = await f.call(
      "/connect?challenge=" +
        challenge +
        "&installation=https://unfoldmail.account.workers.dev&domain=example.com",
    );
    expect(start.status).toBe(302);
    const u = new URL(start.headers.get("location")!);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const state = u.searchParams.get("state");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
        if (!String(_i).includes("oauth2/token")) return network()(_i, init);
        const p = new URLSearchParams(String(init?.body));
        expect(await setupHash(p.get("code_verifier")!)).toBe(
          u.searchParams.get("code_challenge"),
        );
        return Response.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
    );
    const callback = await f.call(
      "/callback?state=" + state + "&code=code",
      "GET",
      undefined,
      cookie,
    );
    expect(callback.status).toBe(302);
    const destination = new URL(callback.headers.get("location")!);
    expect(destination.origin).toBe("https://unfoldmail.account.workers.dev");
    const code = new URLSearchParams(destination.hash.slice(1)).get(
      "oauth_code",
    );
    expect((await f.call("/claim", "POST", { verifier })).status).toBe(400);
    expect(
      (await f.call("/claim", "POST", { verifier, code: "x".repeat(43) }))
        .status,
    ).toBe(409);
    expect(
      (
        await f.call(
          "/callback?state=" + state + "&code=code",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(400);

    expect(
      String(f.sqlite.prepare("SELECT payload FROM grants").get()?.payload),
    ).not.toContain(token);
    expect(
      (await f.call("/claim", "POST", { verifier: "z".repeat(43), code }))
        .status,
    ).toBe(409);
    const claim = await f.call("/claim", "POST", { verifier, code });
    expect(((await claim.json()) as any).token).toBe(token);
    expect((await f.call("/claim", "POST", { verifier, code })).status).toBe(
      409,
    );
    f.sqlite.close();
  });
  it("does not release expired grants", async () => {
    const f = brokerFixture();
    const verifier = "a".repeat(43),
      code = "d".repeat(43);
    f.sqlite
      .prepare("INSERT INTO grants VALUES(?,?,?,?)")
      .run(await setupHash(verifier), "ciphertext", 0, await setupHash(code));
    expect((await f.call("/claim", "POST", { verifier, code })).status).toBe(
      409,
    );
    f.sqlite.close();
  });
  it("binds pending OAuth to the initiating administrator session", async () => {
    const f = fixture();
    f.env.SETUP_OAUTH_BROKER_URL = "https://setup.example.com";
    expect(
      (
        await f.call(
          "/oauth/start",
          "POST",
          {},
          { Cookie: "session_token=one" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(
          "/oauth/finish",
          "POST",
          {},
          { Cookie: "session_token=two" },
        )
      ).status,
    ).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
    f.sqlite.close();
  });
});

describe("setup recovery and readiness regressions", () => {
  const target = {
    zoneId,
    workerName: "unfoldmail",
    webHostname: "mail.example.com",
  };
  it.each(["/subdomains", "/routing/dns", "/catch_all", "/workers/domains"])(
    "recovers a lost response after %s commits without duplicate writes",
    async (endpoint) => {
      const f = fixture();
      identity = await setupIdentity(f.env);
      await f.call("/token", "POST", { token });
      const p = (await (await f.call("/plan", "POST", target)).json()) as any;
      const apply = () => f.call("/apply", "POST", { planId: p.data.id });
      loseResponse = endpoint;
      let failures = 0;
      for (let i = 0; i < 6; i++) {
        const res = await apply();
        if (res.status === 502) failures++;
        else expect(res.status).toBe(200);
      }
      expect(failures).toBe(1);
      expect(writes.filter((w) => w.endsWith(endpoint))).toHaveLength(1);
      expect(((await (await apply()).json()) as any).data.done).toBe(true);
      f.sqlite.close();
    },
  );
  it("still blocks unrelated edits after an ambiguous commit", async () => {
    const f = fixture();
    identity = await setupIdentity(f.env);
    await f.call("/token", "POST", { token });
    const p = (await (await f.call("/plan", "POST", target)).json()) as any;
    loseResponse = "/subdomains";
    expect((await f.call("/apply", "POST", { planId: p.data.id })).status).toBe(
      502,
    );
    records.push({
      id: "other",
      type: "TXT",
      name: "example.com",
      content: "unexpected",
    });
    expect((await f.call("/apply", "POST", { planId: p.data.id })).status).toBe(
      409,
    );
    expect(writes).toHaveLength(1);
    f.sqlite.close();
  });
  it.each(["missing DNS", "public DNS", "hostname", "HTTPS"])(
    "does not report completion with %s pending",
    async (failure) => {
      sendingEnabled = true;
      records = [...sendingDNS, ...receivingDNS];
      rule = {
        enabled: true,
        actions: [{ type: "worker", value: [target.workerName] }],
      };
      domains = [
        {
          hostname: target.webHostname,
          service: target.workerName,
          zone_id: zoneId,
        },
      ];
      if (failure === "missing DNS") records = [];
      if (failure === "hostname") domains = [];
      const cf = new CloudflareSetup(token);
      const plan = await inspectSetup(cf, target, "example.com", identity);
      const base = network();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (i: RequestInfo | URL, o?: RequestInit) => {
          if (
            failure === "public DNS" &&
            String(i).startsWith("https://cloudflare-dns.com")
          )
            return Response.json({ Status: 3 });
          if (
            failure === "HTTPS" &&
            String(i).startsWith("https://mail.example.com")
          )
            throw Error("TLS unavailable");
          return base(i, o);
        }),
      );
      await expect(
        performSetupStep(new CloudflareSetup(token), plan, "verification"),
      ).rejects.toThrow();
    },
  );
  it("enables public Worker fetches on the deployment compatibility date", () => {
    expect(
      readFileSync(join(__dirname, "../../../wrangler.jsonc"), "utf8"),
    ).toContain('"global_fetch_strictly_public"');
  });
  it("rejects OAuth destinations outside the authorizing account", async () => {
    const f = brokerFixture();
    const start = await f.call(
      "/connect?challenge=" +
        (await setupHash("a".repeat(43))) +
        "&installation=https://attacker.other.workers.dev&domain=example.com",
    );
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    );
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const base = network();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (i: RequestInfo | URL, o?: RequestInit) =>
        String(i).includes("oauth2/token")
          ? Response.json({
              access_token: token,
              token_type: "Bearer",
              expires_in: 3600,
            })
          : base(i, o),
      ),
    );
    expect(
      (
        await f.call(
          "/callback?state=" + state + "&code=code",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(403);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM grants").get()?.n).toBe(
      0,
    );
    f.sqlite.close();
  });
});

it("refuses an old or unavailable OAuth broker before saving pending authorization", async () => {
  const f = fixture();
  f.env.SETUP_OAUTH_BROKER_URL = "https://setup.example.com";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ available: true, protocolVersion: 1 })),
  );
  expect((await f.call("/oauth/start", "POST", {})).status).toBe(400);
  expect(
    f.sqlite.prepare("SELECT oauth_pending FROM setup_state").get()
      ?.oauth_pending,
  ).toBeNull();
  f.sqlite.close();
});

describe("Workers fetch receiver", () => {
  it.each(["default", "injected"])(
    "calls the %s transport without a class receiver",
    async (mode) => {
      const transport = vi.fn(function (
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit,
      ) {
        // Mirror the receiver requirement enforced by workerd, which Node fetch lacks.
        if (this !== undefined && this !== globalThis)
          throw new TypeError("Illegal invocation");
        expect(String(input)).toBe(
          "https://api.cloudflare.com/client/v4/zones?per_page=50&page=1",
        );
        expect(init?.redirect).toBe("manual");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer " + token,
        });
        return Promise.resolve(
          Response.json({ success: true, result: [{ id: zoneId }] }),
        );
      });
      vi.stubGlobal("fetch", transport);
      const client =
        mode === "default"
          ? new CloudflareSetup(token)
          : new CloudflareSetup(token, transport as typeof fetch);
      await expect(client.list("/zones")).resolves.toEqual([{ id: zoneId }]);
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
});

it("refuses a Cloudflare API redirect without following it or releasing the credential", async () => {
  const transport = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://other.example/" },
      });
    },
  );
  await expect(
    new CloudflareSetup(token, transport as typeof fetch).list("/zones"),
  ).rejects.toThrow("could not complete");
  expect(transport).toHaveBeenCalledTimes(1);
});


describe("email subdomains", () => {
  const target = {zoneId, workerName: "unfoldmail", webHostname: ""};
  function subFixture() {
    mailDomain = "mail.example.com";
    const f = fixture();
    f.env.EMAIL_DOMAIN = mailDomain;
    f.sqlite.exec("UPDATE users SET email='employee@mail.example.com'");
    return f;
  }
  async function start(f: ReturnType<typeof fixture>) {
    identity = await setupIdentity(f.env);
    expect((await f.call("/token", "POST", {token})).status).toBe(200);
    const res = await f.call("/plan", "POST", target);
    expect(res.status).toBe(200);
    return ((await res.json()) as any).data;
  }
  async function finish(f: ReturnType<typeof fixture>, id: string) {
    for (let i = 0; i < 12; i++) {
      const res = await f.call("/apply", "POST", {planId: id});
      const data = await res.json() as any;
      expect(res.status, JSON.stringify(data)).toBe(200);
      if (data.data.done) return;
    }
    throw Error("setup did not finish");
  }
  it("uses DNS label boundaries and the most specific available zone", () => {
    expect(domainInZone("mail.example.com", "example.com")).toBe(true);
    expect(domainInZone("MAIL.Example.com", "example.com")).toBe(true);
    for (const domain of ["notexample.com", "example.com.evil.net", "mail..example.com", "https://example.com"])
      expect(domainInZone(domain, "example.com")).toBe(false);
    const zone = {id: zoneId, status: "active", account: {id: accountId}};
    expect(matchingZones([{...zone, name: "example.com"}, {...zone, name: "mail.example.com"}], "x.mail.example.com").map(z => z.name)).toEqual(["mail.example.com"]);
  });
  it("connects to the parent zone and lists its workers", async () => {
    const f = subFixture();
    await start(f);
    expect(((await (await f.call("/zones")).json()) as any).data).toEqual([{id: zoneId, name: "example.com"}]);
    expect((await f.call("/workers?zoneId=" + zoneId)).status).toBe(200);
    f.env.EMAIL_DOMAIN = "notexample.com";
    expect((await f.call("/token", "POST", {token})).status).toBe(400);
    f.sqlite.close();
  });
  it("provisions subdomain mail without changing parent MX, catch-all or literal routes", async () => {
    const f = subFixture();
    records.push({id: "parent", type: "MX", name: "example.com", content: "other.provider.test"});
    rule = {enabled: true, actions: [{type: "forward", value: ["external@other.test"]}]};
    const parentRule = {id: "parent-rule", enabled: true, matchers: [{type: "literal", field: "to", value: "employee@example.com"}], actions: [{type: "worker", value: ["another-worker"]}]};
    addressRules.push(parentRule);
    const initialCatchAll = JSON.stringify(rule);
    const p = await start(f);
    expect(p.plan.blockers).toEqual([]);
    await finish(f, p.id);
    expect(JSON.stringify(rule)).toBe(initialCatchAll);
    expect(addressRules[0]).toEqual(parentRule);
    expect(addressRules[1].matchers).toEqual([{type: "literal", field: "to", value: "employee@mail.example.com"}]);
    expect(records.find(r => r.id === "parent")?.content).toBe("other.provider.test");
    expect(writes.some(w => w.includes("catch_all"))).toBe(false);
    const dnsCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/email/routing/dns"));
    expect(dnsCalls.some(([url, init]) => init?.method === "GET" && String(url).includes("subdomain=mail.example.com"))).toBe(true);
    expect(dnsCalls.filter(([, init]) => init?.method === "POST").every(([, init]) => JSON.parse(String(init?.body)).name === mailDomain)).toBe(true);
    f.sqlite.close();
  });
  it.each([true, false])("blocks delegated subdomains and conflicting mailbox routes before writes (enabled=%s)", async (enabled) => {
    const f = subFixture();
    records.push({id: "delegate", type: "NS", name: "mail.example.com", content: "ns.other.test"});
    addressRules.push({enabled, matchers: [{type: "literal", field: "to", value: "employee@mail.example.com"}], actions: [{type: "forward", value: ["elsewhere@example.net"]}]});
    const p = await start(f);
    expect(p.plan.blockers.join()).toContain("delegated");
    expect(p.plan.blockers.join()).toContain("routing rules");
    expect((await f.call("/apply", "POST", {planId:p.id})).status).toBe(409);
    expect(writes).toEqual([]);
    f.sqlite.close();
  });
  it.each([false, true])("automatically enables a disabled mailbox rule (lost response=%s)", async (lost) => {
    const f = subFixture();
    const id = "d".repeat(32);
    addressRules.push({id, priority: 7, enabled: false, matchers: [{type: "literal", field: "to", value: "employee@mail.example.com"}], actions: [{type: "forward", value: ["old@example.net"]}]});
    const disabledCatchAll = {id: "e".repeat(32), enabled: false, matchers: [{type: "all"}], actions: [{type: "drop"}]};
    addressRules.push(disabledCatchAll);
    const p = await start(f);
    expect(p.plan.blockers).toEqual([]);
    if (lost) {
      for(let i=0;i<2;i++) expect((await f.call("/apply","POST",{planId:p.id})).status).toBe(200);
      loseResponse = "/routing/rules/" + id;
      expect((await f.call("/apply","POST",{planId:p.id})).status).toBe(502);
    }
    await finish(f,p.id);
    expect(addressRules).toHaveLength(2);
    expect(addressRules[0]).toMatchObject({id, priority: 7, enabled: true, actions:[{type:"worker",value:["unfoldmail"]}]});
    expect(addressRules[1]).toEqual(disabledCatchAll);
    expect(writes.filter(w => w === "PUT /zones/"+zoneId+"/email/routing/rules/"+id)).toHaveLength(1);
    f.sqlite.close();
  });
  it("creates the mailbox route while leaving an unrelated disabled catch-all alone", async () => {
    const f = subFixture();
    const disabled = {id:"f".repeat(32),enabled:false,matchers:[{type:"all"}],actions:[{type:"drop"}]};
    addressRules.push(disabled);
    const p = await start(f);
    expect(p.plan.blockers).toEqual([]);
    await finish(f,p.id);
    expect(addressRules[0]).toEqual(disabled);
    expect(addressRules[1].enabled).toBe(true);
    f.sqlite.close();
  });
  it("resumes a lost literal-rule response without duplicate rules", async () => {
    const f = subFixture();
    const p = await start(f);
    for (let i=0;i<2;i++) expect((await f.call("/apply","POST",{planId:p.id})).status).toBe(200);
    loseResponse = "/routing/rules";
    expect((await f.call("/apply","POST",{planId:p.id})).status).toBe(502);
    await finish(f,p.id);
    expect(addressRules).toHaveLength(1);
    f.sqlite.close();
  });
  it("continues bounded routing batches and automatically provisions later users", async () => {
    const f = subFixture();
    for(let i=0;i<23;i++) f.sqlite.prepare("INSERT INTO users(id,email,display_name,password_hash,role) VALUES(?,?,'User','h','employee')").run("new"+i, "new"+i+"@mail.example.com");
    const p = await start(f);
    await finish(f,p.id);
    expect(addressRules).toHaveLength(24);
    f.sqlite.prepare("INSERT INTO users(id,email,display_name,password_hash,role) VALUES('later','later@mail.example.com','Later','h','employee')").run();
    await syncSubdomainRouting(f.env);
    expect(addressRules).toHaveLength(25);
    await syncSubdomainRouting(f.env);
    expect(addressRules).toHaveLength(25);
    f.sqlite.prepare("UPDATE setup_state SET credential=NULL").run();
    await syncSubdomainRouting(f.env);
    expect(String(f.sqlite.prepare("SELECT value FROM settings WHERE key='setup_routing_status'").get()?.value)).toContain("Reconnect");
    expect(addressRules).toHaveLength(25);
    f.sqlite.close();
  });
  it("rejects using the email domain as the web hostname before any changes", async () => {
    const f = subFixture();
    await expect(inspectSetup(new CloudflareSetup(token), {...target, webHostname:mailDomain}, mailDomain, identity)).rejects.toThrow("reserved for mail DNS");
    expect(writes).toEqual([]);
    f.sqlite.close();
  });
  it("accepts a sibling web hostname but rejects unrelated hosts", async () => {
    const f = subFixture();
    const plan = await inspectSetup(new CloudflareSetup(token), {...target, webHostname: "web.example.com"}, mailDomain, identity, ["employee@"+mailDomain]);
    expect(plan.blockers).toEqual([]);
    await expect(inspectSetup(new CloudflareSetup(token), {...target, webHostname:"web.example.com.evil.net"}, mailDomain, identity)).rejects.toThrow("selected Cloudflare zone");
    f.sqlite.exec("INSERT INTO settings VALUES('setup_web_origin','https://web.example.com'),('setup_web_zone','example.com')");
    expect((await setupBrowserEnv(f.env)).EXTRA_ALLOWED_ORIGINS).toContain("https://web.example.com");
    f.sqlite.close();
  });
  it("does not accept parent DNS as proof of subdomain readiness", async () => {
    const f = subFixture();
    const p = await start(f);
    const original = network();
    vi.stubGlobal("fetch", vi.fn(async(input: RequestInfo | URL, init?: RequestInit) => String(input).includes("/routing/dns") ? Response.json({success:true,result:receivingDNS}) : original(input,init)));
    await expect(expectedDNS(new CloudflareSetup(token), p.plan, "receiving")).rejects.toThrow("DNS requirements");
    f.sqlite.close();
  });
});


describe("explicit mail migration", () => {
  const target = {zoneId, workerName: "unfoldmail", webHostname: "", migration: "import" as const};
  function oldRule(email = "sales@example.com", id = "d".repeat(32)) {
    return {id, name: "Old forwarding", priority: 10, enabled: true, matchers: [{type:"literal",field:"to",value:email}], actions:[{type:"forward",value:["owner@elsewhere.com"]}]};
  }
  async function prepare(migration: "import" | "discard" = "import") {
    const f = fixture();
    f.env.MAILBOXES = {idFromName: (s: string) => s, get: () => ({provision: async (id: string) => {
      f.sqlite.prepare("UPDATE mailbox_routes SET state='active',provision_new=0 WHERE user_id=?").run(id);
    }})} as unknown as Env["MAILBOXES"];
    identity = await setupIdentity(f.env);
    await f.call("/token", "POST", {token});
    addressRules = [oldRule(), oldRule("person@other.example.com", "e".repeat(32))];
    rule = {enabled: true, matchers:[{type:"all"}], actions:[{type:"forward",value:["owner@elsewhere.com"]}]};
    records = [{id: "f".repeat(32), type:"MX",name:"example.com",content:"old.provider.com",priority:10},
      {id: "9".repeat(32),type:"TXT",name:"_dmarc.example.com",content:"v=DMARC1; p=reject"},
      {id:"8".repeat(32),type:"A",name:"example.com",content:"192.0.2.1"}];
    const res = await f.call("/plan", "POST", {...target, migration});
    expect(res.status).toBe(200);
    const p = (await res.json() as any).data;
    expect(p.plan.blockers).toEqual([]);
    return {...f, p};
  }
  it("discovers source addresses, never forwarding destinations or wildcard addresses", () => {
    expect(routingAddresses([oldRule(), oldRule(), oldRule("a@other.example.com"), {matchers:[{type:"all"}]}], "example.com")).toEqual(["sales@example.com"]);
  });
  it("requires explicit confirmation and supports discarding an unstarted plan", async () => {
    const f = await prepare();
    expect((await f.call("/apply","POST",{planId:f.p.id})).status).toBe(409);
    expect(writes).toEqual([]);
    expect((await f.call("/plan","DELETE")).status).toBe(200);
    expect((await f.call("/apply","POST",{planId:f.p.id,confirmDomain:"example.com"})).status).toBe(409);
    f.sqlite.close();
  });
  it("migrates with backup, imports employee mailboxes, preserves unrelated routes and locks after verification", async () => {
    const f = await prepare();
    let done = false;
    for (let i=0;i<12 && !done;i++) {
      const res = await f.call("/apply","POST",{planId:f.p.id,confirmDomain:"example.com"});
      const json = await res.json() as any;
      expect(json.error).toBeUndefined();
      done = json.data.done;
    }
    expect(done).toBe(true);
    const user = f.sqlite.prepare("SELECT * FROM users WHERE email='sales@example.com'").get() as any;
    expect(user.role).toBe("employee");
    expect(user.must_reset_password).toBe(1);
    expect(user.password_hash).toBe("imported-account-login-disabled");
    expect(addressRules[0].actions).toEqual([{type:"worker",value:["unfoldmail"]}]);
    expect(addressRules[1]).toEqual(oldRule("person@other.example.com","e".repeat(32)));
    expect(records.some(r=>r.type==="A" && r.name==="example.com")).toBe(true);
    const backup = await f.call("/backup");
    expect((await backup.json() as any).plan.snapshot.records.some((r: any)=>r.content==="old.provider.com")).toBe(true);
    for (const [path,method,body] of [["/plan","POST",target],["/token","POST",{token}],["/connection","DELETE",undefined]] as const)
      expect((await f.call(path,method,body)).status).toBe(409);
    expect((await f.call("/unlock","POST",{confirmDomain:"wrong.com"})).status).toBe(400);
    expect((await f.call("/unlock","POST",{confirmDomain:"example.com"})).status).toBe(200);
    f.sqlite.close();
  });
  it("resumes a lost DNS delete response without touching unrelated DNS", async () => {
    const f = await prepare("discard");
    loseResponse = "/dns_records/" + "f".repeat(32);
    const apply = () => f.call("/apply","POST",{planId:f.p.id,confirmDomain:"example.com"});
    expect((await apply()).status).toBe(502);
    expect((await apply()).status).toBe(200);
    expect(f.sqlite.prepare("SELECT id FROM users WHERE email='sales@example.com'").get()).toBeUndefined();
    expect(writes.filter(w=>w.endsWith("f".repeat(32)))).toHaveLength(1);
    expect((await f.call("/plan","DELETE")).status).toBe(409);
    f.sqlite.close();
  });
  it("rejects unrelated concurrent DNS changes during migration", async () => {
    const f = await prepare("discard");
    loseResponse = "/dns_records/" + "f".repeat(32);
    await f.call("/apply","POST",{planId:f.p.id,confirmDomain:"example.com"});
    records = records.filter(r=>r.type!=="A");
    expect((await f.call("/apply","POST",{planId:f.p.id,confirmDomain:"example.com"})).status).toBe(409);
    f.sqlite.close();
  });
});
