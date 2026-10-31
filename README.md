# UnfoldMail

**Grow your team. Keep email costs in your control.**

UnfoldMail is an open-source team email application created and maintained by
[Web Network Solutions](https://webnetworksolution.com). We make the software
available free under the [MIT license](LICENSE) to help startups and organizations
run email in their own cloud account without per-seat software license fees.
You pay your infrastructure and optional AI providers for their services.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Web-Network-Solution/UnfoldMail)

## Start here

- [Deploy an installation](#deploy-your-own-installation)
- [Understand domains and webmail addresses](#email-domain-and-webmail-address)
- [Move an existing email service](#moving-an-existing-email-service)
- [Create users and use the application](#using-and-administering-unfoldmail)
- [Connect mail apps or AI](#optional-features)
- [Understand the modules](#modules-and-repository-map)
- [Develop locally](#local-development)
- [Update an installation](#updates-and-data)
- [Troubleshoot setup](#troubleshooting)
- [Contribute](#contributing-and-support)

## What is included

- Webmail with folders, search, attachments, contacts, and calendar.
- Organization administration, user management, and activity reports.
- Optional AI features with administrator-controlled configuration.
- Per-user mailbox storage using Durable Objects, with D1 for central records,
  R2 for message content and files, and queues for background processing.
- Device-password and mail-protocol APIs. The optional **UnfoldMail Connect**
  gateway is maintained as a separate project; this button deploys webmail only.

This release targets Cloudflare. It is not a generic VPS or arbitrary SMTP-provider
installer. Capacity and cost depend on message volume, attachments, retention,
and concurrency. A guaranteed 1,000-user capacity has not been established by load testing.

## Deploy your own installation

The button starts a guided Cloudflare deployment. No manual database IDs are needed.
It requires this GitHub repository to be public. A fresh-account deployment still
needs end-to-end verification before this template is declared a stable release.

1. Use a Cloudflare account with Workers, D1, R2, Queues, and Email Service available.
   Enable any required billing and verify your mail domain in Cloudflare.
2. Click **Deploy to Cloudflare** and authorize a copy into your own Git account.
3. Choose a Worker name and create new resources. Do not select an existing mail database.
4. Supply the following values in the deployment form:

   | Value | What to enter |
   | --- | --- |
   | `EMAIL_DOMAIN` | Domain used in email addresses, such as `example.com`. |
   | `APP_URL` | Exact HTTPS origin for webmail, e.g. `https://unfoldmail.YOUR-SUBDOMAIN.workers.dev`. No path or trailing slash. |
   | `BOOTSTRAP_SECRET` | A unique random secret of at least 32 characters. Save it securely for first setup. |

   Generate a secret locally with Node.js:
   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```
5. Deploy. The build compiles the web app; the deploy command applies the public D1
   migrations by binding name and deploys the Worker. Cloudflare provisions resources.
6. If the actual URL differs from `APP_URL`, update that variable before opening
   setup and keep the connected repository configuration in sync. Keep the
   Worker's workers.dev address enabled for installation verification.
7. Open the app. Enter the installation secret and create the first administrator
   using an address on `EMAIL_DOMAIN`. Further first-admin creation is then disabled.
8. The **Email setup** wizard opens. **Paste API token** is the primary connection
   method. Create a token scoped to your account/domain using the instructions in
   the wizard. Select this installation's Worker, optionally enter an unused
   webmail hostname, review the changes, and apply them.
9. The wizard enables Email Sending, configures incoming-mail DNS and the required
   Worker routing rules, optionally attaches the webmail hostname, and checks configuration.
   A failed step can be resumed. Setup records each attempt before changing
   Cloudflare and reconciles committed changes after a lost response. Unrelated
   DNS changes still require a new review. Completion requires the expected mail
   DNS records, public DNS resolution, and (when selected) the webmail hostname
   serving this installation over HTTPS. DNS or certificate propagation may
   require waiting and selecting Resume setup. It stops if an existing mail provider or conflicting
   routing/hostname configuration requires a migration decision.
10. Create an employee account. Test an incoming message, an outgoing message to
    an external mailbox, and an attachment before inviting your team. For subdomain email, keep the API token connected for automatic mailbox routing.

The wizard supports a root domain or an email subdomain in an active Cloudflare
zone. For `EMAIL_DOMAIN=mail.example.com`, scope the token to `example.com`;
addresses remain `name@mail.example.com`. A webmail hostname such as
`email.example.com` can be used in the same zone. Parent-domain MX records and
catch-all rules are preserved for subdomain installations.

Cloudflare supports catch-all routing only on the zone apex. For subdomains,
UnfoldMail creates a literal routing rule for each existing mailbox during setup
(or enables an existing disabled rule for that exact address and points it to the selected Worker)
and provisions new mailbox rules through its every-minute scheduled job (up to
20 rules per run). Keep an API token connected with Email Routing Rules Edit and
Zone Read permissions; an expired OAuth credential must be reconnected. Check
**Email setup** for the last routing status before using a new mailbox. Deleted
mailbox rules are retained in Cloudflare; remove unused rules there to reclaim
capacity. They do not restore deleted UnfoldMail users or their mail.
Cloudflare's default limit is 200 routing rules per domain, and recipient
addresses for literal rules are limited to 90 characters. Larger subdomain teams
must request a routing limit increase from Cloudflare. See
[Cloudflare subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/)
and [limits](https://developers.cloudflare.com/email-service/platform/limits/).

Moving from an existing provider requires an explicit migration decision in the wizard.
Registrar nameserver changes, billing, and Email Service eligibility still require
account-owner action. Historical messages require a separate import from their provider. An account's
Pro plan alone does not establish Email Sending eligibility. DNS and HTTPS
certificates may take time to become ready. Configuration completion is not proof
of message delivery. See [Cloudflare domain setup](https://developers.cloudflare.com/email-service/configuration/domains/).

### Email domain and webmail address

These settings serve different purposes:

| Setting | Example | Result |
| --- | --- | --- |
| `EMAIL_DOMAIN` | `example.com` | Employee address: `vishal@example.com` |
| Webmail hostname | `email.example.com` | Website for reading mail: `https://email.example.com` |
| `APP_URL` | `https://email.example.com` | Canonical website origin used by the application |

Using a subdomain for the webmail website does **not** change employee email
addresses. To use `name@example.com`, keep `EMAIL_DOMAIN=example.com`.
The zone selector may show the parent zone even when `EMAIL_DOMAIN` is a subdomain.
The current wizard accepts an unused webmail subdomain within that zone, separate
from the email domain. Leave the optional hostname blank to keep the current URL.

### Credential storage and optional OAuth

API tokens go from your browser to your own Worker and then to Cloudflare. Web
Network Solutions does not receive them. Tokens are encrypted with AES-256-GCM in
D1; the encryption key is derived from a Worker secret, outside the database.
Do not delete or rotate `BOOTSTRAP_SECRET` while setup credentials are saved: it
is the default encryption secret. You may instead set a separate random
`SETUP_ENCRYPTION_KEY` (at least 32 characters) **before connecting**. To change
keys later, remove the stored credential first, change the key, then reconnect.
Back up the encryption secret separately from D1. Encryption at rest does not
protect against someone who controls the Worker and its secrets.

Use these permissions, limited to the account and zone hosting this installation:

| Scope | Permission | Access |
| --- | --- | --- |
| Zone | Zone | Read |
| Zone | DNS | Read for initial setup; **Edit for migration** |
| Zone | Zone Settings | Edit |
| Zone | Email Routing Rules | Edit |
| Account | Email Sending | Edit |
| Account | Workers Scripts | Edit |

Use the corresponding Read permission if Cloudflare lists it separately.
**DNS Read cannot replace conflicting mail DNS records.** Save permission changes
on the existing token, then resume setup; replacing the token value is unnecessary
when only its permissions changed. The
wizard does not require full account access. Removing the stored credential does
not undo configuration or revoke a token at Cloudflare; revoke it there separately.

**Connect with Cloudflare** is an optional OAuth method. It remains unavailable
unless `SETUP_OAUTH_BROKER_URL` is configured for a working setup service. Both
methods use the same review and provisioning steps. The optional service briefly
holds an encrypted OAuth token for a one-time handoff; it retains no refresh token.
Expired OAuth connections require authorization again.

You do not need to register an OAuth application when using **Paste API token**.
If you prefer OAuth, you can either use a working setup service you trust or
[host your own OAuth setup service](deployment/oauth/README.md) with your own
Cloudflare OAuth client, domain, database, and secrets. Self-hosting does not
require a Web Network Solutions account or service. Registering an OAuth client
is required only for whoever operates that optional service.

OAuth is not a dependency of API-token setup or normal mail operations.

A hostname added by the wizard is admitted to the browser-origin allowlist after
successful attachment. Existing `APP_URL` remains the canonical address used in
background-generated links. Keep that address enabled, or update `APP_URL` in
Worker and repository configuration when intentionally changing the canonical URL.

### Moving an existing email service

In **Admin → Email setup**, choose an existing-service option before reviewing:

- **Keep existing settings:** stop when existing mail settings conflict (default).
- **Move to UnfoldMail and import routing addresses:** create missing employee accounts for exact incoming addresses found in Cloudflare routing rules, including disabled rules, then route them to this Worker.
- **Replace routing without importing addresses:** replace routing but do not create accounts. Addresses without an UnfoldMail mailbox will reject incoming mail.

Migration is limited to the installation's email domain. Root-domain migration replaces the catch-all; subdomain migration leaves the parent catch-all unchanged. Exact address rules for other domains and website DNS are preserved. Rules with ambiguous matchers require separate review. Custom addresses not listed in Cloudflare must be created in **Users**; a catch-all cannot enumerate them.

Review the listed addresses and DNS replacements, then type the email domain to confirm. Migration needs **Zone → DNS → Edit** in addition to the normal setup permissions. The original configuration is saved before changes and can be downloaded from the review panel after migration starts. **Discard plan** cancels an unstarted plan; it does not undo changes. A partial migration can be resumed. DNS changes can take time to reach other mail servers.

Imported accounts have no usable password until an administrator sets one in **Users**. Existing users, passwords, and stored messages are preserved. Forwarding destinations are not imported as users. Old messages held by Gmail, Outlook, or another provider are not available through Cloudflare routing and are not copied by this process.

After verification, Email setup becomes read-only. Select **Edit setup** and type the email domain to unlock it. Unlocking alone does not change Cloudflare settings. Test sending and receiving after completing a migration.

## Optional features

For AI, configure `AI_ENCRYPTION_KEY` as a Worker secret before saving provider
credentials. Generate a base64 32-byte value with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
Configure provider credentials and policies through the admin interface. Preserve
this key: changing it can make saved credentials unreadable.

Use the optional [UnfoldMail Connect](https://github.com/Web-Network-Solution/UnfoldMail-Connect)
extension for IMAP/SMTP access. Its README contains Docker deployment and connection
instructions, including a [DigitalOcean Docker Droplet button and guided setup](https://github.com/Web-Network-Solution/UnfoldMail-Connect/blob/main/deployment/digitalocean/README.md).
A dedicated Connect Marketplace image is not yet published.
Leave mail-app access disabled until the gateway, trusted TLS certificate,
and shared `PROTOCOL_GATEWAY_SECRET` are configured. Outlook/Gmail app connectivity
is not enabled by the web deployment alone.

## Using and administering UnfoldMail

Open your installation URL and sign in with your full email address. Employees
use their account password for webmail; mail apps use a separate device password.

| Area | Where to open it | Purpose |
| --- | --- | --- |
| Webmail | Mail | Compose, read, search, organize folders, and handle attachments |
| Contacts and calendar | Workspace navigation | Manage contacts, events, and invitations |
| Employee preferences | Settings | Profile, security, forwarding, and mail-app settings |
| User administration | Admin → Users | Create/edit accounts, set initial passwords, import users, and manage roles |
| Reporting | Admin → Dashboard / Reports | Review activity and storage figures |
| Domain setup | Admin → Email setup | Configure delivery, migrate routing, and inspect setup status |
| External mail apps | Admin → Mail app access | Enable supported protocols after deploying Connect |
| Optional services | Admin → AI assistant / Meeting providers | Configure provider access and policies |
| Storage and delivery policies | Admin → Mailbox storage / Retention / Forwarding | Review storage and organization-wide policies |

Employees access their own workspace. Administrators have limited user/reporting
access. Super administrators also control installation setup and organization
policies. Menu visibility depends on the signed-in role.

### Add an employee

1. In **Admin → Users**, create an account on your configured email domain.
2. Set a temporary password and enable the first-login password-reset requirement.
3. Share the installation URL, full email address, and temporary password securely.
4. The employee signs in and sets their own password before accessing webmail.
5. For email subdomains, wait for the routing status in **Email setup** to confirm
   provisioning. Test receiving and sending before relying on the mailbox.

Accounts imported from routing rules need an administrator to set their initial
password in **Users**. Importing an address does not copy the old provider's password.
A super administrator can switch into a pending-reset account without entering
its password. This does not clear the employee's first-login reset requirement.
Use **Switch Back** to return to the administrator account.

### Connect Outlook or another compatible mail app

Deploy [UnfoldMail Connect](https://github.com/Web-Network-Solution/UnfoldMail-Connect)
first and finish its gateway/TLS configuration. Enable the desired protocols in
**Admin → Mail app access**. Each employee then opens **Settings → Mail apps**, creates
a device password, and uses the hostname shown there with their full email address.
The standard settings are IMAP **993**, SMTP **465** with authentication, and optional
POP3 **995**, all with SSL/TLS. Prefer IMAP for synchronized folders. Client support
varies: a Gmail mobile app account setup is different from Gmail's browser interface.
Follow the extension instructions for the supported client and deployment method.

## Modules and repository map

| Location | Responsibility |
| --- | --- |
| [`packages/web`](packages/web) | React webmail, employee settings, and admin pages |
| [`packages/api/src/index.ts`](packages/api/src/index.ts) | Worker HTTP, incoming-email, queue, and scheduled entry points |
| [`packages/api/src/routes`](packages/api/src/routes) | Authentication, mail, user administration, setup, and feature endpoints |
| [`packages/api/src/middleware`](packages/api/src/middleware) | Request authentication, authorization, and other request guards |
| [`packages/api/src/services`](packages/api/src/services) | Delivery, setup provisioning, storage access, and background service logic |
| [`packages/api/src/durable-objects`](packages/api/src/durable-objects) | Per-user mailbox data, live connections, and AI coordination |
| [`packages/shared/src`](packages/shared/src) | Shared TypeScript contracts and constants |
| [`deployment/migrations`](deployment/migrations) | Public-installation D1 schema and upgrades |
| [`deployment/oauth`](deployment/oauth) | Optional OAuth setup-service deployment |
| [`wrangler.jsonc`](wrangler.jsonc) | Worker bindings, queues, Durable Objects, schedules, and deployment configuration |
| [`packages/api/test`](packages/api/test), [`packages/web/test`](packages/web/test) | API and web regression tests |

Incoming mail reaches the Worker's email handler through Cloudflare routing and
is processed through the inbound queue. Mailbox Durable Objects hold per-user
mailbox data; R2 holds message content and files. D1 stores central account and
configuration records. Outgoing jobs use background processing and Cloudflare
Email Sending. Scheduled work provisions mailboxes and subdomain routing; mailbox
alarms handle tasks such as outbox dispatch and retention. Connect is a separate
service that exposes mail protocols and communicates with the application's APIs.

## Local development

Use Node.js 22.13 or newer in the Node 22 series and npm 11.

```sh
npm ci
npm run setup:local
npm run db:migrate
npm run build
npm run dev:api
```

Open `http://localhost:8787`. The local setup script creates `.dev.vars` once with a
random setup secret and `example.test` as the local email domain. It never replaces
an existing secrets file. Local bindings are simulated; this does not configure
real email delivery. For frontend iteration, run `npm run dev:web` in another terminal.

```sh
npm run typecheck
npm test
npm run build
```

## Updates and data

Use the same provisioned resources for subsequent releases. Back up the D1 database
and establish a recovery plan for Durable Object mailboxes and R2 content before an
upgrade. Test upgrades on a separate installation first; a D1 export alone is not
a complete mailbox backup.

The canonical configuration is root `wrangler.jsonc`. Public migrations are in
`deployment/migrations`; the historical migration files in `packages/api` are kept
for regression tests, not public installation. The initial public migration refuses
an existing application schema. Do not use this template as an in-place migration
of a private/client installation. Subsequent deploys apply only pending migrations.

From a provisioned clone, `npm run deploy` builds, migrates, and deploys. This is a
remote write command: verify the selected Cloudflare account and database first.
Never commit `.dev.vars`, credentials, customer data, database exports, or TLS keys.

### Update a fork or a Cloudflare-created copy

Check which GitHub repository and production branch your Worker is connected to.
Each installation's repository must be updated separately.

- **GitHub fork:** use **Sync fork → Update branch** when available. Review any
  conflicts before merging. See [GitHub's fork update instructions](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork).
- **Cloudflare-created copy:** it may be an independent repository with no **Sync
  fork** button. Create an update branch, apply the relevant upstream commits,
  and open a PR into its production branch. A new PR cannot compare `main` with
  itself. Do not replace the whole repository with the template configuration.

Before merging, preserve your Worker name, D1 IDs, R2 bucket and queue bindings,
`EMAIL_DOMAIN`, `APP_URL`, and other installation-specific settings. Review schema
changes and CI results. If production builds are enabled, merging the connected
branch triggers deployment; otherwise trigger a production build for its latest
commit. Check Cloudflare's deployment status and commit before testing the app.
Reverting application code alone does not reverse database migrations or DNS changes.

### Costs and capacity

There is no UnfoldMail per-seat software fee. Your cloud and optional AI providers
charge separately. Track Worker execution, Durable Object usage, D1 operations,
R2 storage/operations, queues, email sending, and the optional Connect server.
Actual cost depends on usage and provider pricing, not only the number of accounts.

No measured monthly cost table or guaranteed user-capacity benchmark is published
here yet. Before a large rollout, test your expected concurrent users, message rate,
attachment sizes, retention, and queue recovery. A useful benchmark contribution
includes the test revision, workload, latency, failures, and itemized costs without
private email content or credentials.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Token cannot access `EMAIL_DOMAIN` | Scope Zone Read to the parent zone containing the email domain; for `mail.example.com`, select `example.com`. |
| Cloudflare denied an operation | Check account/zone scope and permissions. Migration specifically needs DNS **Edit**, not Read. Sending also needs Email Sending access and account eligibility. |
| Webmail hostname rejected | Enter an unused hostname such as `email.example.com` in the selected zone, without `https://` or a path, or leave it blank. |
| Existing mail settings block setup | Select a migration option, review the affected addresses/records, and confirm the domain. Unrelated or ambiguous rules are not blindly overwritten. |
| Resume setup keeps appearing | Read the error and completed steps. Correct the failing operation, then resume. DNS and HTTPS issuance may take time; a fresh review is required after unrelated configuration changes. |
| Incoming email bounces | Check the exact recipient exists in Users, MX records, and the routing destination. For subdomain email, check automatic routing status. Retry with a fresh message after correcting the issue. |
| Mail appears in Sent but does not arrive | Check sending activity, delivery reports, and spam folders. A saved Sent copy is not delivery confirmation. |
| Outlook rejects authentication | Use the full email address and a valid device password; check SMTP authentication, SSL/TLS, gateway hostname, and ports. |
| Employee cannot enter webmail before resetting a password | Complete the first-login reset. A verified super-admin switch is exempt; update installations running older code if switching redirects to login. |
| Setup fields are disabled | Completed setup is intentionally locked. Select Edit setup and type the domain to unlock. |
| Merge did not update the app | Check the connected repository, production branch, build settings, and deployed commit in Cloudflare. |

For a bug report, include the deployed commit, failing step, exact error, and
sanitized reproduction steps. Do not paste API tokens, cookies, passwords, private
mail, or database exports. Use [SECURITY.md](SECURITY.md) for private vulnerability reports.

## Contributing and support

Source and issues: [Web-Network-Solution/UnfoldMail](https://github.com/Web-Network-Solution/UnfoldMail).
See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Community contributions are welcome. The MIT license does not include a hosting or
support SLA. Third-party packages retain their own licenses.

UnfoldMail is a free open-source project of **Web Network Solutions**.
[Visit Web Network Solutions](https://webnetworksolution.com).

### Make your first contribution

1. Read the module map and run the local development steps above.
2. Browse [open issues](https://github.com/Web-Network-Solution/UnfoldMail/issues).
   For a larger change, agree on the problem and scope in an issue first.
3. Fork the project, create a focused branch, and add a regression test when fixing
   behavior. Documentation and reproducible bug reports are useful contributions too.
4. Run the type checks, tests, and build listed above. Never use a production
   database for development or migration tests.
5. Open a PR explaining the problem, resulting behavior, and validation. Include
   screenshots for interface changes and list any deployment or permission changes.

Useful contribution areas include onboarding instructions, accessibility, mail-client
compatibility, deployment regression tests, and reproducible load/cost measurements.
These are areas for discussion, not promises of scheduled releases.

### Help others discover UnfoldMail

- Star the repository if it is useful, and share the project link with teams that
  need custom-domain email in their own cloud account.
- Publish a short installation walkthrough using a test domain, showing both
  outgoing and incoming mail. Remove credentials and private messages from captures.
- Share honest deployment experiences: what worked, what failed, and what it cost
  for a stated workload. Link back to the relevant issue or PR when reporting a fix.
- Introduce the project in relevant Cloudflare, self-hosting, or developer communities
  where their rules allow it. Ask for specific feedback rather than posting repeated promotions.
- Credit contributors in release notes and make small, well-scoped improvements easy
  to find. Do not claim benchmark results, guaranteed savings, or integrations that
  have not been verified.

The project welcomes feedback and contributions through its public repository.
For general outreach guidance, see [Finding users for an open-source project](https://opensource.guide/finding-users/).
