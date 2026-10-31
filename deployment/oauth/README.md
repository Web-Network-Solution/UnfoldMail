# Optional UnfoldMail OAuth setup service

This guide is for users who choose to host their own OAuth setup service.
**Paste API token** is the default method and requires none of these steps.
If you use an existing setup service, its operator handles OAuth registration;
you only configure its URL and approve access in Cloudflare.

You can run this service entirely in your own Cloudflare account, using your own
OAuth client and domain. It does not depend on Web Network Solutions infrastructure.
Do not enable its URL in UnfoldMail until authorization has been tested successfully.

## Self-host your OAuth service

The examples below use `setup.example.com`. Replace it with a hostname you own,
separate from your webmail hostname. Run the commands from the repository root.

1. In Cloudflare, open **Manage Account > OAuth clients > Create client**.
   You need Super Administrator, Administrator, or OAuth Client Write access.
   Register the client under your own account:
   - Name: UnfoldMail Setup
   - Client URL: `https://setup.example.com`
   - Redirect URL: `https://setup.example.com/callback`
   - Grant: `authorization_code`; response: `code`.
   - Authentication: `client_secret_post` (recommended for this server service),
     or `none` with PKCE. S256 PKCE is used in both cases.
   - Select scopes corresponding to Zone Write, DNS Write, Zone Settings Write,
     Email Routing Rules Write, Email Sending Write, and Workers Scripts Write.
     Obtain the actual scope values from Cloudflare's client registration screen
     or `/client/v4/oauth/scopes`; do not invent scope identifiers.
2. Keep the client **private** if only members of your Cloudflare account will
   authorize it. If you intend to serve users outside that account, supply the
   required logo and client details, verify domain ownership, test the private
   client, then promote it to **public**.
   [Cloudflare client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
   documents these requirements. Public visibility cannot be reverted to private.
3. Create an isolated broker database from the repository root:

   ```sh
   npx wrangler d1 create unfoldmail-setup
   ```

   Put its ID in `deployment/oauth/wrangler.jsonc`. This database must never be a
   customer mail database. Set `OAUTH_CLIENT_ID` and space-separated `OAUTH_SCOPES`
   to the registered values. Update both `routes[0].pattern` to your hostname
   (for example `setup.example.com`) and `vars.BROKER_ORIGIN` to its exact HTTPS
   origin (for example `https://setup.example.com`, without a trailing slash).
   The registered redirect URL must be that origin followed by `/callback`.
   The hostname must belong to a zone in your Cloudflare account.
4. Set the encryption secret, and the client secret if using `client_secret_post`:

   ```sh
   npx wrangler secret put BROKER_ENCRYPTION_KEY --config deployment/oauth/wrangler.jsonc
   npx wrangler secret put OAUTH_CLIENT_SECRET --config deployment/oauth/wrangler.jsonc
   ```

   Generate a random encryption secret of at least 32 characters. Never commit it.
   Skip the client-secret command only for a client registered with auth method `none`.
5. Migrate and deploy this service independently of the mail app:

   ```sh
   npx wrangler d1 migrations apply BROKER_DB --remote --config deployment/oauth/wrangler.jsonc
   npx wrangler deploy --config deployment/oauth/wrangler.jsonc
   ```

6. Verify `/status` reports `available: true` and `protocolVersion: 2`. Test authorization, cancellation,
   expiration, and successful credential retrieval from a disposable UnfoldMail
   installation. This status only verifies required configuration, not the client
   registration or Cloudflare permissions.
7. In that installation, set the Worker variable `SETUP_OAUTH_BROKER_URL` to
   `https://setup.example.com` and preserve it in its deployment
   configuration. The wizard now offers OAuth under the optional-method section.

## Flow and retention

The authenticated installation creates a random verifier and saves it encrypted,
bound to the initiating administrator session. Only its SHA-256 challenge is put
in the service URL, alongside the installation origin and mail domain. The service uses a separate state cookie and S256 PKCE for
Cloudflare authorization. Tokens never appear in URLs or the browser response.

Before handing back authorization, the service checks the granted Cloudflare
account: the mail zone must be active, and the destination must be a Worker in
that account with the UnfoldMail bindings. Custom destinations must also belong
to the mail zone. It never fetches an arbitrary destination to prove ownership.

The callback redirects the authorizing browser to that installation with a random
one-time delivery code in the URL fragment. The app immediately removes the
fragment and sends the code to its authenticated setup endpoint when the user
selects **Finish connection**. The original administrator session must match.

The service encrypts the access token until the installation claims it using both
the original verifier and the browser delivery code. Knowing or choosing the
original challenge is insufficient to retrieve someone else's authorization.
Claim atomically removes the grant; a wrong code does not consume it. Pending authorization
expires after ten minutes; a completed grant expires after five minutes or when
its access token expires, whichever comes first. Cleanup runs every five minutes.
No refresh token is retained. Removal in the app deletes its local copy; users can
also revoke the authorization in their Cloudflare account.

The broker has no arbitrary redirect URL or configurable token endpoint. API calls
use fixed Cloudflare endpoints. Request logging is disabled to avoid recording
OAuth callback codes. Do not add proxy/access logging that captures callback
query strings, credentials, request bodies, or cookies. The state and grant
stores are separate from all mailbox databases. The callback is browser-only;
claim is a server-to-server capability exchange and does not need CORS.

Failed exchanges or lost one-time responses require a fresh authorization. This
service does not automatically purchase plans, change registrar nameservers,
replace existing MX records, or grant Email Sending eligibility.

## Verification

`npm run typecheck` and `npm test` include the broker. A packaging check is:

```sh
npx wrangler deploy --dry-run --config deployment/oauth/wrangler.jsonc
```

The placeholder database ID may be replaced with a non-production UUID for this
local packaging check. A dry run does not prove that OAuth is registered or live.

## Upgrading the handoff protocol

Deploy the app and broker from this version together. Broker migration
`0002_browser_handoff.sql` adds destination and delivery-code fields and clears
only pending OAuth flows and unclaimed grants from the old protocol. Users with
an unfinished authorization must start again. It does not touch mailbox data or
credentials already saved in an installation. The app refuses protocol-v1 brokers.
Keep OAuth disabled until the real client has passed the end-to-end checks above.
