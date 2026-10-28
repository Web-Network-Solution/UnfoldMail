# UnfoldMail

**Grow your team. Keep email costs in your control.**

UnfoldMail is an open-source team email application created and maintained by
[Web Network Solutions](https://webnetworksolution.com). We make the software
available free under the [MIT license](LICENSE) to help startups and organizations
run email in their own cloud account without per-seat software license fees.
You pay your infrastructure and optional AI providers for their services.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Web-Network-Solution/UnfoldMail)

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
9. The wizard enables Email Sending, configures incoming-mail DNS and the catch-all
   Worker rule, optionally attaches the webmail hostname, and checks configuration.
   A failed step can be resumed. It stops if an existing mail provider or conflicting
   routing/hostname configuration requires a migration decision.
10. Create an employee account. Test an incoming message, an outgoing message to
    an external mailbox, and an attachment before inviting your team. Then remove
    the saved setup credential if you do not need further setup operations.

The wizard currently supports an active **root domain matching `EMAIL_DOMAIN`**.
Subdomain mail, moving existing providers, registrar nameserver changes, billing,
and Email Service eligibility still require account-owner action. An account's
Pro plan alone does not establish Email Sending eligibility. DNS and HTTPS
certificates may take time to become ready. Configuration completion is not proof
of message delivery. See [Cloudflare domain setup](https://developers.cloudflare.com/email-service/configuration/domains/).

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

The token needs Zone Read, DNS Read, Zone Settings Edit, Email Routing Rules Edit,
Email Sending Edit, and Workers Scripts Edit on the selected zone/account. The
wizard does not require full account access. Removing the stored credential does
not undo configuration or revoke a token at Cloudflare; revoke it there separately.

**Connect with Cloudflare** is an optional OAuth method. It remains unavailable
unless `SETUP_OAUTH_BROKER_URL` is configured for a working setup service. Both
methods use the same review and provisioning steps. The optional service briefly
holds an encrypted OAuth token for a one-time handoff; it retains no refresh token.
Expired OAuth connections require authorization again.

Web Network Solutions' intended service address is
`https://unfoldmail-setup.webnetworksolution.in`. The service implementation and
[publisher deployment instructions](deployment/oauth/README.md) are included.
The public OAuth client must be registered and the service deployed before this
address can be enabled in customer installations. It is not a dependency of
API-token setup or normal mail operations.

A hostname added by the wizard is admitted to the browser-origin allowlist after
successful attachment. Existing `APP_URL` remains the canonical address used in
background-generated links. Keep that address enabled, or update `APP_URL` in
Worker and repository configuration when intentionally changing the canonical URL.

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

## Contributing and support

Source and issues: [Web-Network-Solution/UnfoldMail](https://github.com/Web-Network-Solution/UnfoldMail).
See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Community contributions are welcome. The MIT license does not include a hosting or
support SLA. Third-party packages retain their own licenses.

UnfoldMail is a free open-source project of **Web Network Solutions**.
[Visit Web Network Solutions](https://webnetworksolution.com).
