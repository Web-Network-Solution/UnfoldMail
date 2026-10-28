import { setupHash } from "./setup-crypto";
export class SetupError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export async function boundedJSON<T>(response: Response): Promise<T> {
  if (!response.body)
    throw new SetupError("Cloudflare returned an empty response.", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024)
        throw new SetupError(
          "Cloudflare response is too large. Narrow the token to the required account.",
          502,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SetupError("Cloudflare returned an invalid response.", 502);
  }
}
type Envelope<T> = {
  success: boolean;
  result: T;
  result_info?: { total_pages?: number };
};
export class CloudflareSetup {
  private deadline = Date.now() + 60000;
  constructor(
    private token: string,
    private transport: typeof fetch = fetch,
  ) {}
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Envelope<T>> {
    if (!/^\/(zones|accounts)(\/|\?)/.test(path))
      throw new SetupError("Unsupported Cloudflare operation.");
    if (Date.now() >= this.deadline)
      throw new SetupError("Setup check timed out. Retry.", 504);
    let response: Response;
    try {
      response = await this.transport(
        "https://api.cloudflare.com/client/v4" + path,
        {
          method,
          headers: {
            Authorization: "Bearer " + this.token,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(15000, this.deadline - Date.now())),
          ),
        },
      );
    } catch {
      throw new SetupError(
        "Cloudflare could not be reached. Retry this step.",
        502,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SetupError(
        response.status === 401 || response.status === 403
          ? "Cloudflare denied this operation. Check token permissions and Email Service eligibility."
          : response.status === 429
            ? "Cloudflare is busy. Wait a moment and retry."
            : "Cloudflare could not complete this operation. Review the account settings and retry.",
        response.status === 404 ? 404 : 502,
      );
    }
    const data = await boundedJSON<Envelope<T>>(response);
    if (!data.success)
      throw new SetupError("Cloudflare did not accept this operation.", 502);
    return data;
  }
  async get<T>(path: string): Promise<T> {
    return (await this.request<T>(path)).result;
  }
  async list<T>(path: string): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.request<T[]>(
        path + (path.includes("?") ? "&" : "?") + "per_page=50&page=" + page,
      );
      if (!Array.isArray(data.result))
        throw new SetupError("Unexpected Cloudflare list response.", 502);
      rows.push(...data.result);
      if (
        data.result_info?.total_pages
          ? page >= data.result_info.total_pages
          : data.result.length < 50
      )
        return rows;
    }
    throw new SetupError(
      "Too many resources. Use a token limited to this account/domain.",
    );
  }
  async optional<T>(path: string, fallback: T): Promise<T> {
    try {
      return await this.get<T>(path);
    } catch (e) {
      if (e instanceof SetupError && e.status === 404) return fallback;
      throw e;
    }
  }
}
export type Zone = {
  id: string;
  name: string;
  status: string;
  account: { id: string; name?: string };
};
type RecordRow = { id: string; type: string; name: string; content: string };
type Rule = {
  enabled?: boolean;
  actions?: { type: string; value?: string[] }[];
};
export type Target = {
  zoneId: string;
  workerName: string;
  webHostname: string;
};
export type Plan = {
  target: Target;
  domain: string;
  accountId: string;
  changes: string[];
  blockers: string[];
  digest: string;
};
export function validTarget(value: unknown): Target {
  const v = value as Partial<Target> | null;
  if (
    !v ||
    !/^([a-f0-9]{32})$/.test(v.zoneId || "") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(v.workerName || "") ||
    typeof v.webHostname !== "string"
  )
    throw new SetupError("Choose a domain and Worker.");
  return {
    zoneId: v.zoneId!,
    workerName: v.workerName!,
    webHostname: v.webHostname.trim().toLowerCase(),
  };
}
export async function inspectSetup(
  cf: CloudflareSetup,
  target: Target,
  domain: string,
  identity: string,
): Promise<Plan> {
  const zone = await cf.get<Zone>("/zones/" + target.zoneId);
  if (zone.status !== "active")
    throw new SetupError(
      "This domain is not active on Cloudflare. Complete its nameserver setup first.",
    );
  if (zone.name.toLowerCase() !== domain.toLowerCase())
    throw new SetupError(
      "Automatic setup currently requires the selected root domain to match EMAIL_DOMAIN. Subdomain mail needs separate routing configuration.",
    );
  if (
    target.webHostname &&
    (!target.webHostname.endsWith("." + domain) ||
      !target.webHostname
        .split(".")
        .every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) ||
      target.webHostname.length > 253)
  )
    throw new SetupError("Use a webmail hostname within your email domain.");
  const accountId = zone.account.id;
  if (!/^[a-f0-9]{32}$/.test(accountId))
    throw new SetupError("Invalid Cloudflare account response.", 502);
  const worker =
    "/accounts/" +
    accountId +
    "/workers/scripts/" +
    encodeURIComponent(target.workerName);
  const settings = await cf.get<{
    bindings?: { name: string; type: string }[];
  }>(worker + "/settings");
  if (
    !["DB", "MAILBOXES", "EMAIL_BUCKET"].every((name) =>
      settings.bindings?.some((b) => b.name === name),
    )
  )
    throw new SetupError(
      "Select the Worker running this UnfoldMail installation.",
    );
  const sub = await cf.get<{ subdomain: string }>(
    "/accounts/" + accountId + "/workers/subdomain",
  );
  if (!/^[a-z0-9-]+$/.test(sub.subdomain))
    throw new SetupError("Invalid Workers subdomain.", 502);
  // No credentials are sent to the Worker. Its identity binds this plan to this installation.
  let remote: { id?: string };
  try {
    const res = await fetch(
      "https://" +
        target.workerName +
        "." +
        sub.subdomain +
        ".workers.dev/api/setup/identity",
      { redirect: "error", signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) throw Error();
    remote = await boundedJSON(res);
  } catch {
    throw new SetupError(
      "Enable the selected Worker’s workers.dev address so this installation can be verified.",
    );
  }
  if (remote.id !== identity)
    throw new SetupError("That Worker belongs to a different installation.");
  const records = await cf.list<RecordRow>(
    "/zones/" + zone.id + "/dns_records",
  );
  const catchAll = await cf.optional<Rule>(
    "/zones/" + zone.id + "/email/routing/rules/catch_all",
    {},
  );
  let rules: Rule[] = [];
  try {
    rules = await cf.list<Rule>("/zones/" + zone.id + "/email/routing/rules");
  } catch (e) {
    if (!(e instanceof SetupError && e.status === 404)) throw e;
  }
  const domains = await cf.list<{ hostname: string; service: string }>(
    "/accounts/" + accountId + "/workers/domains",
  );
  const blockers: string[] = [];
  const sameAction = (rule: Rule) =>
    rule.actions?.length === 1 &&
    rule.actions[0].type === "worker" &&
    rule.actions[0].value?.length === 1 &&
    rule.actions[0].value[0] === target.workerName;
  if (
    records.some(
      (r) =>
        r.type === "MX" &&
        r.name === domain &&
        !/^route[0-9]+\.mx\.cloudflare\.net\.?$/i.test(r.content),
    )
  )
    blockers.push(
      "An existing mail provider is configured. No MX records will be removed. Plan a migration before continuing.",
    );
  if (
    records.some(
      (r) =>
        r.type === "TXT" &&
        r.name === domain &&
        r.content.replace(/^"|"$/g, "").startsWith("v=spf1") &&
        !r.content.includes("include:_spf.mx.cloudflare.net"),
    )
  )
    blockers.push(
      "An existing SPF policy needs review before enabling Cloudflare mail.",
    );
  if (catchAll.enabled && !sameAction(catchAll))
    blockers.push(
      "An active catch-all rule sends mail elsewhere. It will not be overwritten.",
    );
  if (rules.some((rule) => rule.enabled && !sameAction(rule)))
    blockers.push(
      "Existing address-specific routing rules need review. They will not be overwritten.",
    );
  if (target.webHostname) {
    const current = domains.find((d) => d.hostname === target.webHostname);
    if (current && current.service !== target.workerName)
      blockers.push("The webmail hostname is attached to another Worker.");
    if (!current && records.some((r) => r.name === target.webHostname))
      blockers.push(
        "The webmail hostname already has DNS records. Choose an unused hostname.",
      );
  }
  // Read sending availability before making any routing changes.
  const senders = await cf.list<{ name: string; enabled: boolean }>(
    "/zones/" + zone.id + "/email/sending/subdomains",
  );
  const sendingAlreadyEnabled = senders.some(
    (s) => s.name === domain && s.enabled,
  );
  if (
    !sendingAlreadyEnabled &&
    records.some((r) =>
      [
        "cf-bounce." + domain,
        "cf-bounce._domainkey." + domain,
        "_dmarc." + domain,
      ].includes(r.name),
    )
  )
    blockers.push(
      "Existing sending-authentication DNS needs review before Cloudflare sending is enabled. It will not be replaced automatically.",
    );
  return {
    target,
    domain,
    accountId,
    blockers,
    changes: [
      "Enable Cloudflare sending and its authentication DNS records.",
      "Enable incoming mail DNS records.",
      "Route unmatched incoming addresses to this UnfoldMail Worker.",
      ...(target.webHostname
        ? ["Attach " + target.webHostname + " to the Worker."]
        : []),
    ],
    digest: await setupHash(
      JSON.stringify({
        target,
        records: records.sort((a, b) => a.id.localeCompare(b.id)),
        catchAll,
        rules: rules.map((r) => JSON.stringify(r)).sort(),
        domains: domains.sort((a, b) => a.hostname.localeCompare(b.hostname)),
      }),
    ),
  };
}
export const SETUP_STEPS = [
  "sending",
  "receiving",
  "routing",
  "hostname",
  "verification",
] as const;
export async function performSetupStep(
  cf: CloudflareSetup,
  plan: Plan,
  step: string,
) {
  const zone = "/zones/" + plan.target.zoneId;
  switch (step) {
    case "sending": {
      const senders = await cf.list<{ name: string; enabled: boolean }>(
        zone + "/email/sending/subdomains",
      );
      if (!senders.some((s) => s.name === plan.domain && s.enabled))
        await cf.request(zone + "/email/sending/subdomains", "POST", {
          name: plan.domain,
        });
      break;
    }
    case "receiving":
      await cf.request(zone + "/email/routing/dns", "POST", {
        name: plan.domain,
      });
      break;
    case "routing":
      await cf.request(zone + "/email/routing/rules/catch_all", "PUT", {
        enabled: true,
        name: "UnfoldMail",
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [plan.target.workerName] }],
      });
      break;
    case "hostname":
      if (plan.target.webHostname)
        await cf.request(
          "/accounts/" + plan.accountId + "/workers/domains",
          "PUT",
          {
            hostname: plan.target.webHostname,
            service: plan.target.workerName,
            zone_id: plan.target.zoneId,
          },
        );
      break;
    case "verification": {
      const sending = await cf.list<{ name: string; enabled: boolean }>(
        zone + "/email/sending/subdomains",
      );
      const receiving = await cf.get<{ enabled: boolean }>(
        zone + "/email/routing",
      );
      const rule = await cf.get<Rule>(zone + "/email/routing/rules/catch_all");
      if (
        !sending.some((s) => s.name === plan.domain && s.enabled) ||
        !receiving.enabled ||
        !rule.enabled ||
        rule.actions?.[0]?.type !== "worker" ||
        rule.actions[0].value?.[0] !== plan.target.workerName
      )
        throw new SetupError(
          "Cloudflare configuration is still pending. Wait and retry verification.",
        );
      break;
    }
    default:
      throw new SetupError("Unknown setup step.");
  }
}
