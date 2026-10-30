import { useEffect, useState } from "react";
import { useAuthStore } from "../../stores";
import "./Setup.css";
type Plan = {
  id: string;
  expires: number;
  plan: {
    changes: string[];
    blockers: string[];
    target: { zoneId: string; workerName: string; webHostname: string };
  };
};
type Status = {
  routingStatus?: string | null;
  connected: boolean;
  method: string | null;
  domain: string;
  oauthAvailable: boolean;
  progress: string[];
  plan: Plan | null;
};
async function request<T>(
  path = "",
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch("/api/admin/setup" + path, {
    method,
    credentials: "include",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || !json.success)
    throw new Error(json.error || "Setup request failed. Try again.");
  return json.data;
}
export default function Setup() {
  const role = useAuthStore((s) => s.user?.role);
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [token, setToken] = useState(""),
    [zoneId, setZoneId] = useState(""),
    [workerName, setWorkerName] = useState(""),
    [hostname, setHostname] = useState("");
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]),
    [workers, setWorkers] = useState<{ id: string }[]>([]);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthUrl, setOauthUrl] = useState("");
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const code = fragment.get("oauth_code");
    if (code) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      if (/^[A-Za-z0-9_-]{43}$/.test(code)) setOauthCode(code);
    }
  }, []);
  async function refresh() {
    const s = await request<Status>();
    setStatus(s);
    if (s.plan) {
      setZoneId(s.plan.plan.target.zoneId);
      setWorkerName(s.plan.plan.target.workerName);
      setHostname(s.plan.plan.target.webHostname);
    }
    if (s.connected) {
      const z = await request<{ id: string; name: string }[]>("/zones");
      setZones(z);
      setZoneId((v) => v || z[0]?.id || "");
    }
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup failed. Retry.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (role === "super_admin") void run(refresh);
  }, [role]);
  useEffect(() => {
    setWorkers([]);
    if (!zoneId || !status?.connected) return;
    let active = true;
    request<{ id: string }[]>("/workers?zoneId=" + zoneId)
      .then((w) => {
        if (active) setWorkers(w);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [zoneId, status?.connected]);
  if (role !== "super_admin")
    return (
      <div className="admin-page">
        Only a super administrator can configure setup.
      </div>
    );
  async function apply() {
    if (!status?.plan) return;
    let done = false;
    while (!done) {
      const result = await request<{ done: boolean; progress: string[] }>(
        "/apply",
        "POST",
        { planId: status.plan.id },
      );
      done = result.done;
      setStatus((s) => (s ? { ...s, progress: result.progress } : s));
    }
    await refresh();
  }
  return (
    <div className="admin-page setup-page">
      <h1>Set up email</h1>
      <p>Connect Cloudflare, review the changes, then configure your domain.</p>
      {error && (
        <div role="alert" className="setup-error">
          {error}
        </div>
      )}
      {status?.routingStatus && <p role="status">{status.routingStatus}</p>}
      {!status && !error && <p role="status">Loading setup…</p>}
      <fieldset disabled={busy} className="setup-section">
        <legend>1. Connect Cloudflare</legend>
        <p>
          Paste an API token. It is stored encrypted in this installation and is
          sent only to Cloudflare for setup. It is not sent to Web Network
          Solutions.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await request("/token", "POST", { token });
              setToken("");
              setOauthUrl("");
              await refresh();
            });
          }}
        >
          <label htmlFor="setup-token">API token</label>
          <input
            id="setup-token"
            className="form-input"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            maxLength={4096}
          />
          <button className="btn btn-primary" type="submit">
            {status?.connected
              ? "Replace connection"
              : "Connect with API token"}
          </button>
        </form>
        <details>
          <summary>Create a token</summary>
          <ol>
            <li>
              Open{" "}
              <a
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare API tokens
              </a>{" "}
              and select Create Token → Create Custom Token.
            </li>
            <li>
              Limit it to the account and Cloudflare zone used by this installation. For mail.example.com, select example.com.
            </li>
            <li>
              Allow Zone Read, DNS Read, Zone Settings Edit, Email Routing Rules
              Edit, Email Sending Edit, and Workers Scripts Edit. Use the
              corresponding Read permission where Cloudflare lists it
              separately.
            </li>
            <li>
              Create the token, copy it, and paste it above. An account-wide
              full-access token is not required.
            </li>
          </ol>
          <p>
            The wizard checks access before applying changes. Cloudflare Email
            Sending must be available on your account.
          </p>
        </details>
        <details>
          <summary>Optional: connect with Cloudflare OAuth</summary>
          <p>
            This method uses the configured setup service to temporarily
            exchange your authorization for a credential. Your installation
            retrieves and encrypts it. API-token setup does not use this
            service.
          </p>
          {status?.oauthAvailable ? (
            <>
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void run(async () => {
                    const r = await request<{ url: string }>(
                      "/oauth/start",
                      "POST",
                    );
                    setOauthCode("");
                    setOauthUrl(r.url);
                  })
                }
              >
                Start OAuth connection
              </button>
              {oauthUrl && (
                <p>
                  <a href={oauthUrl} target="_blank" rel="noreferrer">
                    Open Cloudflare authorization
                  </a>{" "}
                  in a new tab. After authorization you will return to this
                  installation. Select Finish connection there.
                </p>
              )}
              <button
                className="btn"
                type="button"
                disabled={!oauthCode}
                onClick={() =>
                  void run(async () => {
                    await request("/oauth/finish", "POST", { code: oauthCode });
                    setOauthCode("");
                    setOauthUrl("");
                    await refresh();
                  })
                }
              >
                Finish connection
              </button>
            </>
          ) : (
            <p>
              OAuth is not enabled for this installation. Paste an API token
              above.
            </p>
          )}
        </details>
        {status?.connected && (
          <p role="status">
            Connected using{" "}
            {status.method === "oauth" ? "OAuth" : "an API token"}.{" "}
            <button
              type="button"
              className="btn"
              onClick={() =>
                void run(async () => {
                  await request("/connection", "DELETE");
                  setToken("");
                  setOauthUrl("");
                  setWorkers([]);
                  setZones([]);
                  await refresh();
                })
              }
            >
              Remove stored credential
            </button>
          </p>
        )}
        <p className="setup-note">
          Removing the credential keeps existing email configuration but stops automatic provisioning of new subdomain mailboxes. Revoke the
          token in Cloudflare if you no longer need it.
        </p>
      </fieldset>
      {status?.connected && (
        <fieldset className="setup-section" disabled={busy}>
          <legend>2. Choose this installation</legend>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const plan = await request<Plan>("/plan", "POST", {
                  zoneId,
                  workerName,
                  webHostname: hostname,
                });
                setStatus((s) => (s ? { ...s, plan, progress: [] } : s));
              });
            }}
          >
            <label htmlFor="setup-zone">Email domain</label>
            <select
              id="setup-zone"
              className="form-input"
              value={zoneId}
              onChange={(e) => {
                setZoneId(e.target.value);
                setWorkerName("");
              }}
              required
            >
              <option value="">Choose domain</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
            <label htmlFor="setup-worker">UnfoldMail Worker</label>
            <select
              id="setup-worker"
              className="form-input"
              value={workerName}
              onChange={(e) => setWorkerName(e.target.value)}
              required
            >
              <option value="">
                Choose the Worker created during deployment
              </option>
              {workers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.id}
                </option>
              ))}
            </select>
            <label htmlFor="setup-host">Webmail hostname (optional)</label>
            <input
              id="setup-host"
              className="form-input"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder={"mail." + status.domain}
            />
            <p>
              Leave blank to keep the current web address. The hostname can be a sibling of the email subdomain within the selected zone. Use an unused
              hostname. Cloudflare must finish issuing its HTTPS certificate
              before it opens.
            </p>
            <button className="btn btn-primary" type="submit">
              Review changes
            </button>
          </form>
        </fieldset>
      )}
      {status?.connected && status.plan && (
        <fieldset className="setup-section" disabled={busy}>
          <legend>3. Review and apply</legend>
          <p>
            These changes apply to {status.domain}, using Worker{" "}
            {status.plan.plan.target.workerName}.
          </p>
          <ul>
            {status.plan.plan.changes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {status.plan.plan.blockers.map((s) => (
            <p className="setup-error" key={s}>
              {s}
            </p>
          ))}
          <p role="status">
            Completed:{" "}
            {status.progress.length
              ? status.progress.join(", ")
              : "No changes yet."}
          </p>
          {status.progress.includes("verification") ? (
            <>
              <h2>Configuration complete</h2>
              <p>
                Send a test message to an external address, confirm it arrives,
                then reply to verify incoming mail. Configuration checks do not
                prove message delivery.
              </p>
              <p>For subdomain email, keep an API token connected so new mailbox routing rules can be provisioned automatically. OAuth credentials expire and must be reconnected. Existing routes remain if you disconnect.</p>
            </>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={status.plan.plan.blockers.length > 0}
              onClick={() => void run(apply)}
            >
              {busy
                ? "Applying…"
                : status.progress.length
                  ? "Resume setup"
                  : "Apply reviewed changes"}
            </button>
          )}
        </fieldset>
      )}
    </div>
  );
}
