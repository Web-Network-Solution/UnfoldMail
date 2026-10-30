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
      // Native Workers fetch rejects a class instance as its receiver.
      // Invoke the injected transport as a standalone function.
      const transport = this.transport;
      response = await transport(
        "https://api.cloudflare.com/client/v4" + path,
        {
          method,
          headers: {
            Authorization: "Bearer " + this.token,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
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
export function domainInZone(domain: string, zone: string): boolean {
  const valid = (s: string) => s.length <= 253 && s.split(".").length >= 2 &&
    s.split(".").every(x => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(x));
  return valid(domain) && valid(zone) && (domain.toLowerCase() === zone.toLowerCase() ||
    domain.toLowerCase().endsWith("." + zone.toLowerCase()));
}
export function matchingZones(zones: Zone[], domain: string): Zone[] {
  const matches = zones.filter(z => domainInZone(domain, z.name));
  const longest = Math.max(0, ...matches.map(z => z.name.length));
  return matches.filter(z => z.name.length === longest);
}
export type Zone = {
  id: string;
  name: string;
  status: string;
  account: { id: string; name?: string };
};
type RecordRow = {
  id?: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  proxied?: boolean;
};
type DomainRow = { hostname: string; service: string; zone_id?: string };
type Snapshot = {
  records: RecordRow[];
  catchAll: Rule;
  rules: Rule[];
  domains: DomainRow[];
};
export type Rule = {
  id?: string;
  tag?: string;
  priority?: number;
  name?: string;
  matchers?: {type: string; field?: string; value?: string}[];
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
  zoneName?: string;
  recipients?: string[];
  accountId: string;
  changes: string[];
  blockers: string[];
  digest: string;
  identity: string;
  snapshot: Snapshot;
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
  recipients: string[] = [],
): Promise<Plan> {
  const zone = await cf.get<Zone>("/zones/" + target.zoneId);
  if (zone.status !== "active")
    throw new SetupError(
      "This domain is not active on Cloudflare. Complete its nameserver setup first.",
    );
  domain = domain.toLowerCase();
  if (!domainInZone(domain, zone.name))
    throw new SetupError(
      "Select the Cloudflare zone containing EMAIL_DOMAIN.",
    );
  if (
    target.webHostname &&
    (!target.webHostname.endsWith("." + zone.name.toLowerCase()) ||
      !target.webHostname
        .split(".")
        .every((x) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) ||
      target.webHostname.length > 253)
  )
    throw new SetupError("Use a webmail hostname within the selected Cloudflare zone.");
  if (target.webHostname === domain)
    throw new SetupError("Leave Webmail hostname blank to keep the current URL, or choose a different hostname. The email domain is reserved for mail DNS records.");
  const subdomain = domain !== zone.name.toLowerCase();
  recipients = [...new Set(recipients.map(r => r.toLowerCase()))].filter(r => r.endsWith("@" + domain)).sort();
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
      { redirect: "manual", signal: AbortSignal.timeout(10000) },
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
  const domains = await cf.list<DomainRow>(
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
  if (!subdomain && catchAll.enabled && !sameAction(catchAll))
    blockers.push(
      "An active catch-all rule sends mail elsewhere. It will not be overwritten.",
    );
  if (rules.some((rule) => subdomain
    ? recipients.some(email => recipientConflict(rule, email, target.workerName))
    : rule.enabled && !sameAction(rule)))
    blockers.push(
      "Existing address-specific routing rules need review. They will not be overwritten.",
    );
  if (subdomain && recipients.some(r => r.length > 90))
    blockers.push("Cloudflare subdomain routing supports recipient addresses up to 90 characters.");
  if (subdomain && records.some(r => r.type === "NS" && domainInZone(domain, r.name) && r.name !== zone.name))
    blockers.push("The email subdomain is delegated to other nameservers. Select its authoritative Cloudflare zone.");
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
    zoneName: zone.name.toLowerCase(),
    recipients: subdomain ? recipients : undefined,
    identity,
    snapshot: { records, catchAll, rules, domains },
    accountId,
    blockers,
    changes: [
      "Enable Cloudflare sending and its authentication DNS records.",
      "Enable incoming mail DNS records.",
      ...(subdomain ? [
        "Create or enable individual incoming-mail rules for " + recipients.length + " existing mailboxes on " + domain + ". Parent-domain routing stays unchanged.",
        "Keep the API token connected: new mailbox rules are provisioned automatically by the scheduled job. Cloudflare routing-rule limits apply.",
      ] : ["Route unmatched incoming addresses to this UnfoldMail Worker."]),
      ...(target.webHostname
        ? ["Attach " + target.webHostname + " to the Worker."]
        : []),
    ],
    digest: await setupHash(
      JSON.stringify({
        target,
        recipients: subdomain ? recipients : undefined,
        records: records.sort((a, b) => (a.id || "").localeCompare(b.id || "")),
        catchAll,
        rules: rules.map((r) => JSON.stringify(r)).sort(),
        domains: domains.sort((a, b) => a.hostname.localeCompare(b.hostname)),
      }),
    ),
  };
}
function dnsName(name: string, domain: string) {
  return name === "@" ? domain : name.toLowerCase().replace(/\.$/, "");
}
function dnsContent(r: RecordRow) {
  return r.type === "TXT"
    ? r.content.replace(/"\s*"/g, "").replace(/^"|"$/g, "")
    : r.content.toLowerCase().replace(/\.$/, "");
}
function recordKey(r: RecordRow, domain: string) {
  return JSON.stringify([
    r.type,
    dnsName(r.name, domain),
    dnsContent(r),
    r.type === "MX" ? r.priority : null,
    !!r.proxied,
  ]);
}
export function sameRule(rule: Rule, worker: string) {
  return (
    rule.enabled === true &&
    rule.actions?.length === 1 &&
    rule.actions[0].type === "worker" &&
    rule.actions[0].value?.length === 1 &&
    rule.actions[0].value[0] === worker
  );
}
export function isSubdomainPlan(plan: Plan) {
  return !!plan.zoneName && plan.domain !== plan.zoneName;
}
export function ruleMatches(rule: Rule, email: string) {
  return rule.matchers?.some(m => m.type === "all" || (m.type === "literal" && m.field === "to" && m.value?.toLowerCase() === email)) || false;
}
function literalRecipient(rule: Rule, email: string) {
  return rule.matchers?.length === 1 && rule.matchers[0].type === "literal" && ruleMatches(rule, email);
}
function ruleId(rule: Rule) {
  const id = rule.id || rule.tag || "";
  return /^[a-f0-9]{32}$/i.test(id) ? id : "";
}
export function recipientRule(rule: Rule, email: string, worker: string) {
  return literalRecipient(rule, email) && sameRule(rule, worker);
}
function recipientConflict(rule: Rule, email: string, worker: string) {
  if (!ruleMatches(rule, email)) return false;
  // A disabled catch-all or multi-address rule has no effect. Leave it untouched.
  if (rule.enabled === false) return literalRecipient(rule, email) && !ruleId(rule);
  return !recipientRule(rule, email, worker);
}
function desiredRecipientRule(plan: Plan, email: string, previous?: Rule) {
  return {
    name: "UnfoldMail " + plan.identity + ": " + email,
    enabled: true,
    matchers: [{type: "literal", field: "to", value: email}],
    actions: [{type: "worker", value: [plan.target.workerName]}],
    ...(previous?.priority !== undefined ? {priority: previous.priority} : {}),
  };
}
function permittedRecipientUpdate(before: Rule, after: Rule, plan: Plan) {
  return before.enabled === false && !!ruleId(before) && ruleId(before) === ruleId(after) &&
    (plan.recipients || []).some(email => literalRecipient(before, email) &&
      recipientRule(after, email, plan.target.workerName) &&
      after.name === desiredRecipientRule(plan, email).name &&
      (before.priority === undefined || before.priority === after.priority));
}
export async function provisionRecipientRules(cf: CloudflareSetup, plan: Plan): Promise<boolean> {
  const rules = plan.snapshot.rules;
  const recipients = plan.recipients || [];
  const operations: {email: string; previous?: Rule}[] = [];
  for (const email of recipients) {
    if (email.length > 90 || !email.endsWith("@" + plan.domain)) throw new SetupError("Invalid subdomain recipient.");
    if (rules.some(r => recipientConflict(r, email, plan.target.workerName)))
      throw new SetupError("An active mailbox routing rule conflicts. Review it in Cloudflare before continuing.");
    if (rules.some(r => recipientRule(r, email, plan.target.workerName))) continue;
    const disabled = rules.filter(r => r.enabled === false && literalRecipient(r, email));
    if (disabled.length) operations.push(...disabled.map(previous => ({email, previous})));
    else operations.push({email});
  }
  for (const {email, previous} of operations.slice(0, 20)) {
    await cf.request("/zones/" + plan.target.zoneId + "/email/routing/rules" +
      (previous ? "/" + ruleId(previous) : ""), previous ? "PUT" : "POST",
      desiredRecipientRule(plan, email, previous));
  }
  return operations.length <= 20;
}
export async function expectedDNS(
  cf: CloudflareSetup,
  plan: Plan,
  kind: "sending" | "receiving",
): Promise<RecordRow[]> {
  const zone = "/zones/" + plan.target.zoneId;
  let path = zone + "/email/routing/dns" + (isSubdomainPlan(plan) ? "?subdomain=" + encodeURIComponent(plan.domain) : "");
  if (kind === "sending") {
    const senders = await cf.list<{
      name: string;
      enabled: boolean;
      tag: string;
    }>(zone + "/email/sending/subdomains");
    const sender = senders.find((s) => s.name === plan.domain && s.enabled);
    if (!sender || !/^[a-f0-9]{32}$/.test(sender.tag))
      throw new SetupError(
        "Sending configuration is still pending. Retry setup.",
      );
    path = zone + "/email/sending/subdomains/" + sender.tag + "/dns";
  }
  const result = await cf.get<RecordRow[] | {records: RecordRow[]}>(path);
  const rows = Array.isArray(result) ? result : result?.records;
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 20 ||
    rows.some(
      (r) =>
        !r ||
        !["MX", "TXT", "CNAME"].includes(r.type) ||
        typeof r.name !== "string" ||
        typeof r.content !== "string" ||
        !r.content ||
        !(
          dnsName(r.name, plan.domain) === plan.domain ||
          dnsName(r.name, plan.domain).endsWith("." + plan.domain)
        ),
    )
  )
    throw new SetupError(
      "Cloudflare DNS requirements are unavailable. Retry setup.",
    );
  return rows;
}
function hasRecords(
  actual: RecordRow[],
  expected: RecordRow[],
  domain: string,
) {
  return expected.every((r) =>
    actual.some((a) => recordKey(a, domain) === recordKey(r, domain)),
  );
}
// A lost response must not allow unrelated configuration changes to escape review.
export async function reconcileSetup(
  cf: CloudflareSetup,
  before: Plan,
  after: Plan,
  attempted: string,
) {
  if (
    !before.snapshot ||
    before.accountId !== after.accountId ||
    before.domain !== after.domain ||
    JSON.stringify(before.target) !== JSON.stringify(after.target) ||
    JSON.stringify(before.recipients) !== JSON.stringify(after.recipients)
  )
    throw new SetupError("Review a new setup plan after upgrading.", 409);
  const a = before.snapshot,
    b = after.snapshot;
  const sorted = (values: string[]) => JSON.stringify(values.sort());
  const fail = () => {
    throw new SetupError(
      "Domain settings changed outside setup. Review a new plan.",
      409,
    );
  };
  if (
    sorted(a.rules.map((r) => JSON.stringify(r))) !==
    sorted(b.rules.map((r) => JSON.stringify(r))) &&
    !(attempted === "routing" && isSubdomainPlan(after) &&
      a.rules.every(r => b.rules.some(x => JSON.stringify(x) === JSON.stringify(r) || permittedRecipientUpdate(r, x, after))) &&
      b.rules.every(r => a.rules.some(x => JSON.stringify(x) === JSON.stringify(r) || permittedRecipientUpdate(x, r, after)) ||
        (!a.rules.some(x => ruleId(x) && ruleId(x) === ruleId(r)) && r.name?.startsWith("UnfoldMail " + after.identity + ": ") &&
         (after.recipients || []).some(email => recipientRule(r, email, after.target.workerName)))))
  )
    fail();
  if (
    JSON.stringify(a.catchAll) !== JSON.stringify(b.catchAll) &&
    !(attempted === "routing" && !isSubdomainPlan(after) && sameRule(b.catchAll, after.target.workerName))
  )
    fail();
  const domainKey = (d: DomainRow) =>
    JSON.stringify([d.hostname, d.service, d.zone_id]);
  const permittedDomain = (d: DomainRow) =>
    attempted === "hostname" &&
    d.hostname === after.target.webHostname &&
    d.service === after.target.workerName &&
    d.zone_id === after.target.zoneId;
  if (
    a.domains.some(
      (d) => !b.domains.some((x) => domainKey(x) === domainKey(d)),
    ) ||
    b.domains.some(
      (d) =>
        !a.domains.some((x) => domainKey(x) === domainKey(d)) &&
        !permittedDomain(d),
    )
  )
    fail();
  const expected =
    attempted === "sending" || attempted === "receiving"
      ? await expectedDNS(cf, after, attempted)
      : [];
  const permittedRecord = (r: RecordRow) =>
    expected.some(
      (e) => recordKey(e, after.domain) === recordKey(r, after.domain),
    );
  // Existing records cannot disappear or be silently replaced, even during retry.
  if (!hasRecords(b.records, a.records, after.domain)) fail();
  for (const r of b.records) {
    if (
      a.records.some(
        (x) => recordKey(x, after.domain) === recordKey(r, after.domain),
      )
    )
      continue;
    if (permittedRecord(r)) continue;
    // Workers custom domains may generate a proxied DNS record. Ownership is checked above.
    if (
      attempted === "hostname" &&
      r.name === after.target.webHostname &&
      r.proxied &&
      b.domains.some(permittedDomain)
    )
      continue;
    fail();
  }
}
async function verifyDNS(cf: CloudflareSetup, plan: Plan) {
  const expected = [
    ...(await expectedDNS(cf, plan, "sending")),
    ...(await expectedDNS(cf, plan, "receiving")),
  ];
  if (!hasRecords(plan.snapshot.records, expected, plan.domain))
    throw new SetupError(
      "Required mail DNS records are missing or changed. Restore them and retry verification.",
    );
  // Bounded concurrent public lookups; credentials never leave the Cloudflare API client.
  const queries = [
    ...new Set(
      expected.map((r) =>
        JSON.stringify([dnsName(r.name, plan.domain), r.type]),
      ),
    ),
  ];
  await Promise.all(
    queries.map(async (q) => {
      const [name, type] = JSON.parse(q) as [string, string];
      try {
        const res = await fetch(
          "https://cloudflare-dns.com/dns-query?" +
            new URLSearchParams({ name, type }),
          {
            headers: { Accept: "application/dns-json" },
            redirect: "manual",
            signal: AbortSignal.timeout(8000),
          },
        );
        if (!res.ok) throw Error();
        const data = await boundedJSON<{
          Status: number;
          Answer?: { name: string; type: number; data: string }[];
        }>(res);
        const code = { MX: 15, TXT: 16, CNAME: 5 }[type];
        const answers = (data.Answer || []).filter(
          (a) => a.type === code && dnsName(a.name, plan.domain) === name,
        );
        if (
          data.Status !== 0 ||
          !expected
            .filter(
              (r) => dnsName(r.name, plan.domain) === name && r.type === type,
            )
            .every((r) =>
              answers.some((a) =>
                type === "MX"
                  ? a.data.toLowerCase().replace(/\.$/, "") ===
                    r.priority + " " + dnsContent(r)
                  : dnsContent({ ...r, content: a.data }) === dnsContent(r),
              ),
            )
        )
          throw Error();
      } catch {
        throw new SetupError(
          "Public mail DNS is still pending. Wait and retry verification.",
        );
      }
    }),
  );
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
      if (
        (isSubdomainPlan(plan) || (await cf.get<{ enabled: boolean }>(zone + "/email/routing")).enabled) &&
        hasRecords(
          plan.snapshot.records,
          await expectedDNS(cf, plan, "receiving"),
          plan.domain,
        )
      )
        break;
      await cf.request(zone + "/email/routing/dns", "POST", {
        name: plan.domain,
      });
      break;
    case "routing":
      if (isSubdomainPlan(plan)) return provisionRecipientRules(cf, plan);
      if (sameRule(plan.snapshot.catchAll, plan.target.workerName)) break;
      await cf.request(zone + "/email/routing/rules/catch_all", "PUT", {
        enabled: true,
        name: "UnfoldMail",
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [plan.target.workerName] }],
      });
      break;
    case "hostname":
      if (
        plan.target.webHostname &&
        !plan.snapshot.domains.some(
          (d) =>
            d.hostname === plan.target.webHostname &&
            d.service === plan.target.workerName &&
            d.zone_id === plan.target.zoneId,
        )
      )
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
      const subdomain = isSubdomainPlan(plan);
      const receiving = subdomain ? {enabled: true} : await cf.get<{ enabled: boolean }>(zone + "/email/routing");
      const routingReady = subdomain
        ? (plan.recipients || []).every(email => plan.snapshot.rules.some(r => recipientRule(r, email, plan.target.workerName)))
        : sameRule(await cf.get<Rule>(zone + "/email/routing/rules/catch_all"), plan.target.workerName);
      if (
        !sending.some((s) => s.name === plan.domain && s.enabled) ||
        !receiving.enabled ||
        !routingReady
      )
        throw new SetupError(
          "Cloudflare configuration is still pending. Wait and retry verification.",
        );
      await verifyDNS(cf, plan);
      if (plan.target.webHostname) {
        if (
          !plan.snapshot.domains.some(
            (d) =>
              d.hostname === plan.target.webHostname &&
              d.service === plan.target.workerName &&
              d.zone_id === plan.target.zoneId,
          )
        )
          throw new SetupError(
            "The webmail hostname is not attached to this Worker. Retry hostname setup.",
          );
        try {
          const res = await fetch(
            "https://" + plan.target.webHostname + "/api/setup/identity",
            { redirect: "manual", signal: AbortSignal.timeout(8000) },
          );
          if (
            !res.ok ||
            (await boundedJSON<{ id?: string }>(res)).id !== plan.identity
          )
            throw Error();
        } catch {
          throw new SetupError(
            "Webmail HTTPS is still pending or points elsewhere. Wait and retry verification.",
          );
        }
      }
      break;
    }
    default:
      throw new SetupError("Unknown setup step.");
  }
}
