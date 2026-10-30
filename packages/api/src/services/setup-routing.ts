import type { Env } from "../types";
import { CloudflareSetup, SetupError, domainInZone, provisionRecipientRules, type Plan, type Rule, type Target, type Zone } from "./setup-cloudflare";
import { openSetup } from "./setup-crypto";
import { setupState, setupKey, withSetupLock } from "./setup-state";

// Runs under the same lease as onboarding. Existing rules are never overwritten.
// A lost POST response is recovered by listing rules on the next invocation.
export async function syncSubdomainRouting(env: Env): Promise<void> {
  const configured = await env.DB.prepare("SELECT value FROM settings WHERE key='setup_routing_target'").first<{value: string}>();
  if (!configured) return;
  await withSetupLock(env, async () => {
    try {
      const config = JSON.parse(configured.value) as {target: Target; domain: string; zoneName: string; identity: string};
      if (config.domain !== env.EMAIL_DOMAIN.toLowerCase() || !domainInZone(config.domain, config.zoneName))
        throw new SetupError("Email domain changed. Review email setup again.");
      const state = await setupState(env);
      if (!state.credential || (state.expires_at && state.expires_at <= Date.now()))
        throw new SetupError("Reconnect an API token in Email setup to provision new subdomain mailboxes. Existing rules remain in place.");
      const cf = new CloudflareSetup(await openSetup(setupKey(env), state.credential, "cloudflare-token"));
      const zone = await cf.get<Zone>("/zones/" + config.target.zoneId);
      if (zone.name.toLowerCase() !== config.zoneName || zone.status !== "active")
        throw new SetupError("The email zone changed. Review email setup again.");
      const users = await env.DB.prepare("SELECT email FROM users ORDER BY email").all<{email: string}>();
      const recipients = users.results.map(r => r.email.toLowerCase()).filter(email => email.endsWith("@" + config.domain));
      const rules = await cf.list<Rule>("/zones/" + config.target.zoneId + "/email/routing/rules");
      const plan: Plan = {...config, recipients, accountId: zone.account.id, changes: [], blockers: [], digest: "", snapshot: {records: [], rules, catchAll: {}, domains: []}};
      const done = await provisionRecipientRules(cf, plan);
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES('setup_routing_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(done ? "Mailbox routing is up to date. Checked " + new Date().toISOString() : "Mailbox routing is being provisioned. The next scheduled run will continue.").run();
    } catch (error) {
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES('setup_routing_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(error instanceof SetupError ? error.message : "Mailbox routing could not be checked. Reconnect your API token and retry email setup.").run();
    }
  });
}
