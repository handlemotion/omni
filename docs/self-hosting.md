# Self-hosting Omni

Status: draft. Each unit adds its required services, bindings, and variables here as it lands.

## What you need

- Node.js 26 (the exact version is in `.nvmrc`) and pnpm at the version in `package.json`
  `packageManager`. Node 25+ no longer ships corepack, so install pnpm directly
  (`npm install -g pnpm@<version>`).
- A Cloudflare account (Workers Paid for Queues and Durable Objects, R2).
- A Postgres database reachable from Cloudflare Hyperdrive and from the mail service.
- One always-on container host for `apps/mail` (we use Fly.io; any Docker host works).
- Any IMAP/SMTP mail host. Purelymail's admin API is optional.
- An Anthropic API key for triage and summaries.

## Local run

```bash
pnpm install
pnpm stack:up                         # Postgres, GreenMail, S3-compatible object store
cp packages/db/.env.example packages/db/.env
pnpm --filter @omni/db db:migrate     # create the schema
cp apps/mail/.env.example apps/mail/.env
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

## Database

Omni needs Postgres 16 or newer (the local stack runs 18). Migrations are plain SQL in
`packages/db/migrations`, applied in order by drizzle-kit:

```bash
DATABASE_URL=postgres://user:pass@host:5432/omni pnpm --filter @omni/db db:migrate
```

Run this before the first start and after every upgrade, before deploying the new Worker and
mail service. Migrations are additive-first, so the running version keeps working while they
apply. The database is an index of your mail host: if it is lost, re-sync rebuilds it.

## Variables

Filled in per unit: see each unit's `.env.example`.

| Variable                | Used by                         | Required | Notes                                                                   |
| ----------------------- | ------------------------------- | -------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`          | migrations, mail service, tests | yes      | `postgres://` URL. The Worker reaches the same database via Hyperdrive. |
| `BETTER_AUTH_SECRET`    | Worker (auth)                   | yes      | At least 32 random characters.                                          |
| `BETTER_AUTH_URL`       | Worker (auth)                   | yes      | Public origin of the API.                                               |
| `AUTH_TRUSTED_ORIGINS`  | Worker (auth)                   | no       | Comma-separated web/app origins allowed to call auth.                   |
| `AUTH_PASSKEY_RP_ID`    | Worker (auth)                   | no       | WebAuthn relying party ID; defaults to the `BETTER_AUTH_URL` host.      |
| `APP_NAME`              | Worker (auth)                   | no       | Shown in passkey prompts; defaults to `Omni`.                           |
| `GOOGLE_CLIENT_ID`      | Worker (auth)                   | no       | With `GOOGLE_CLIENT_SECRET`, turns on sign-in with Google.              |
| `GOOGLE_CLIENT_SECRET`  | Worker (auth)                   | no       | Secret. Set together with `GOOGLE_CLIENT_ID`, or neither.               |
| `ORGANIZATION_CREATION` | Worker (auth)                   | no       | `owners` (default) or `anyone`: who may create a workspace in the app.  |
| `PURELYMAIL_API_TOKEN`  | mail service                    | no       | Secret. Lets onboarding create domains, users and app passwords.        |

### Mail service (`apps/mail`)

The mail service is the only process that speaks IMAP and SMTP. It works with any standards-based
host. CONDSTORE and IDLE are used when the server offers them; without them it falls back to
UID-list diffs and polling. On every connect it logs the server's capabilities
(`imap.capabilities`).

| Variable                   | Required | Default            | Purpose                                                         |
| -------------------------- | -------- | ------------------ | --------------------------------------------------------------- |
| `MAIL_SERVICE_HMAC_SECRET` | yes      |                    | Signs Worker → mail service pings; same value in the Worker.    |
| `DATABASE_URL`             | yes      |                    | Postgres the service writes the mail index to.                  |
| `MAIL_CREDENTIALS_KEY`     | yes      |                    | Keyring `k1:<base64 32 bytes>[,k0:...]`, current key first.     |
| `S3_ENDPOINT`              | yes      |                    | S3 API endpoint: R2, MinIO, AWS, or the local gateway.          |
| `S3_BUCKET`                | yes      |                    | Bucket for raw mail, sanitized HTML and attachments.            |
| `S3_ACCESS_KEY_ID`         | yes      |                    | S3 key pair (for R2: an R2 API token with object read/write).   |
| `S3_SECRET_ACCESS_KEY`     | yes      |                    |                                                                 |
| `S3_REGION`                | no       | `auto`             | Signing region; R2 uses `auto`.                                 |
| `IMAGE_PROXY_URL`          | no       | `/api/image-proxy` | Worker image proxy that remote images in HTML go through.       |
| `ATTACHMENT_URL`           | no       | `/api/attachments` | Worker route for inline `cid:` images.                          |
| `PORT`                     | no       | `8788`             | HTTP port for `/health` and `/ping`.                            |
| `LOG_LEVEL`                | no       | `info`             | `debug`, `info`, `warn`, or `error`. Logs are JSON on stdout.   |
| `SYNC_INTERVAL_MS`         | no       | `300000`           | Sync interval for non-inbox folders (INBOX is live via IDLE).   |
| `OUTBOX_INTERVAL_MS`       | no       | `30000`            | Outbox poll interval when no ping arrives.                      |
| `MAILBOX_CONCURRENCY`      | no       | `4`                | Mailboxes connecting or syncing at once.                        |
| `PURELYMAIL_API_TOKEN`     | no       |                    | Purelymail admin API token. Unset: onboarding uses IMAP logins. |
| `SENTRY_DSN`               | no       |                    | Sentry DSN. Unset keeps error reporting off.                    |
| `SENTRY_ENVIRONMENT`       | no       | `production`       | Sentry environment tag.                                         |
| `DNS_RESOLVERS`            | no       | system resolvers   | `ip` or `ip:port` list used to find a domain's nameservers.     |
| `DNS_NAMESERVER_PORT`      | no       | `53`               | Port nameservers are asked on. Change only for a test server.   |
| `DNS_TIMEOUT_MS`           | no       | `2000`             | Per-query DNS timeout.                                          |

Generate the secrets with `openssl rand -hex 32` and `echo "k1:$(openssl rand -base64 32)"`.
Keep `MAIL_CREDENTIALS_KEY` only on the mail service. To rotate it, put the new key first
(`k2:<new>,k1:<old>`); stored credentials still decrypt by their key id.

On start the service connects every mailbox whose status is not `disabled` and resumes each
folder from its saved sync position. A signed ping, or the next sync interval, picks up
mailboxes added later.

The Worker and the mail service call each other over HMAC-signed HTTP (`@omni/crypto`, 60 s
window). The Worker pings `POST /ping` after writing to the outbox or adding a mailbox, and calls
`POST /provision/domain`, `POST /provision/mailbox` and `POST /dns/lookup` during onboarding
(ADR 0007, ADR 0010); the mail
service posts batches of `message.created` events to the Worker after indexing new mail. Paths
and bodies are defined once in `packages/contracts`.

Objects are keyed by content hash under `<org id>/<mailbox id>/` (`raw/<sha256>.eml`,
`html/<sha256>.html`, `att/<sha256>`), so a re-sync rewrites the same keys. The local stack runs
[Versity S3 Gateway](https://github.com/versity/versitygw) on `localhost:7070` with the bucket
`omni-mail-dev` already created.

### First organization

Sign-up is by invitation only, so an install starts from the command line. In this order:

1. **Create the organization and its owner** with the same `DATABASE_URL` as the service:

   ```bash
   pnpm --filter @omni/db org:create --name "Acme" --owner you@example.com
   ```

   It creates the organization (keyed by slug, derived from `--name` unless you pass `--slug`),
   your user if missing, and your owner membership, then prints `{"orgId", ...}` as JSON.
   Running it again changes nothing and prints the same ids.

2. **Add mailboxes** (next section), using that `orgId` and `--owner you@example.com`. Add the
   `SYSTEM_MAIL_FROM` mailbox (for example `no-reply@example.com`) too: sign-in links and
   invitations are sent from it.

3. **Sign in** with a magic link to the owner address. Owners and admins then invite everyone
   else from the app (Better Auth invitations); an invited person signs in by magic link with
   the invited address and accepts. A magic-link request for an address with no account and no
   pending invitation gets the same answer as any other, but no email.

### Onboarding in the app

`/onboarding` in the web app sets up a workspace: its name, its domain, its mailboxes, and
invitations. An owner or admin whose workspace has no mailboxes is sent there after signing in.
Owners can also open it to create another workspace; with `ORGANIZATION_CREATION=anyone`, any
signed-in user without a workspace is sent there too (sign-up itself stays invitation-only).

What the Domain and Mailboxes steps do depends on the mail service:

- **With `PURELYMAIL_API_TOKEN`:** the domain is added to that Purelymail account, and the app
  lists the DNS records to add (ownership TXT, MX, SPF, three DKIM CNAMEs, DMARC), each marked
  verified or waiting, with a re-check. Purelymail accepts the domain once the ownership record is
  in DNS. Each mailbox becomes a Purelymail user with an Omni app password. Omni never keeps the
  user's real password: it is random and thrown away, and the person sets their own in
  Purelymail if they want another mail app.
- **Without it:** the domain stays where it is. The app asks for the IMAP and SMTP servers
  (`host` or `host:port`; 993 and 465 use TLS from the start, other ports upgrade with STARTTLS
  when the server offers it) and a password per mailbox. The mail service checks each login over
  IMAP before storing it.

Either way the credentials are encrypted with `MAIL_CREDENTIALS_KEY` by the mail service, and the
mailbox starts syncing at once.

#### Domain ownership (ADR 0010)

Adding a domain opens a claim with a one-time TXT record, `_omni-challenge.<domain>`, whose
value the app shows once (only its hash is stored). The domain is locked to the first workspace
whose record shows up in the domain's DNS; until then several workspaces may wait on it, and a
claim expires after 7 days. Each workspace may hold 5 waiting claims. Subdomains of a locked
domain cannot be claimed by another workspace, and names that mix alphabets (a Cyrillic letter
in a Latin name) are refused.

The mail service reads records from the domain's own nameservers (it finds them through
`DNS_RESOLVERS`, then asks them directly on port 53), so a saved record verifies within seconds
instead of waiting out a public resolver's cache. The host it runs on needs outbound DNS (UDP and
TCP port 53).

Each check reads every record from the nameservers and says why one is not passing yet:
not found, found with another value (shown), an SPF record already there (merge our include into
it; the page shows the merged record), MX pointing at another host (mail moves when it changes),
or a CNAME at a name that needs another record. When the nameservers belong to a host the app
knows (Cloudflare, GoDaddy, Namecheap, Route 53 and others), it shows where to add records
there. While the DNS page is open the Worker re-checks on its own (5 s, 10 s, 30 s, then every
minute, for up to 30 minutes) through the `DOMAIN_WATCH` Durable Object, and pushes each result
over the realtime socket; "Check record" still checks at once.

"Set up automatically" (Domain Connect) needs templates published under your own domain and
onboarded by each DNS host; see `docs/domain-connect/README.md`. It stays hidden until
`DOMAIN_CONNECT_PROVIDER_ID` is set and the host confirms it has the template.

Keep the record after setup. The Worker's cron trigger re-checks every verified domain every six
hours; if the record is gone, sending from the domain pauses (the domain stays locked) and the
workspace's owners get an email, and again when it is back. Owners can release a domain or move
it to another workspace they run, once it has no mailboxes; every step is in the audit log
(`GET /api/onboarding/domains/:id/events`).

### Adding a mailbox from the command line

Mailboxes can also be added from the command line with the same `DATABASE_URL` and
`MAIL_CREDENTIALS_KEY` as the service. The owner must already be a member of the organization
(`org:create` above, or an accepted invitation). The app password is read from stdin so it never
lands in shell history:

```bash
# Any IMAP/SMTP host
printf '%s' "$APP_PASSWORD" | pnpm --filter @omni/mail mailbox:add \
  --org <org id> --address you@example.com --owner you@example.com \
  --provider imap --imap imap.example.com:993 --smtp smtp.example.com:465

# Purelymail: servers are known; optionally let its API create the app password
pnpm --filter @omni/mail mailbox:add --org <org id> --address you@example.com \
  --owner you@example.com --create-app-password      # needs PURELYMAIL_API_TOKEN
```

In the Docker image the same CLI is `node dist/mailbox-add.js` (for example
`docker run -i --rm --env-file apps/mail/.env omni-mail node dist/mailbox-add.js --org ...`).

It checks the IMAP login (`--no-verify` skips that), encrypts the credentials bound to the
mailbox id, stores the mailbox with an owner grant, and prints the mailbox id. Running it again
for the same address replaces the credentials. With `MAIL_SERVICE_URL` set it pings the running
service, which connects the mailbox immediately; otherwise it is picked up on the next sync
interval. `--kind shared` adds a shared inbox (read state stays per person; `\Seen` is never
changed on the server). A shared inbox gets a team with the owner on it; owners and admins add
and remove its members through `PUT`/`DELETE /api/mailboxes/<id>/members/<member id>` (ADR
0008). Upgrading an install whose shared inboxes predate teams: run
`pnpm --filter @omni/db mailbox-teams:backfill` once after `db:migrate` (safe to repeat).

Run from source: `pnpm --filter @omni/mail start` reads `apps/mail/.env`. Variables already set
in the environment win over the file.

Run in Docker (any host that keeps one container always on):

```bash
docker build -f apps/mail/Dockerfile -t omni-mail .
docker run -d --restart unless-stopped --env-file apps/mail/.env -p 8788:8788 omni-mail
curl localhost:8788/health
```

Run on Fly.io (what we use): `apps/mail/fly.toml` keeps one machine always on, with no auto-stop
and a health check on `/health`. Never scale past one machine: two would open duplicate IDLE
connections and race on the outbox.

```bash
flyctl apps create <your-app>
flyctl secrets import --app <your-app> < apps/mail/.env    # or set them one by one
flyctl deploy . --config apps/mail/fly.toml --app <your-app>
curl https://<your-app>.fly.dev/health
```

Set the Worker's `MAIL_SERVICE_URL` to `https://<your-app>.fly.dev`.

The container runs as a non-root user. Point your host's health check at `GET /health`. It
handles `SIGTERM` gracefully: in-flight syncs and actions finish and mailboxes log out.
Expose `/ping` only to your Worker.

### Worker (`apps/worker`)

One Cloudflare Worker serves the web app (`apps/web`), the API (`/api/*`), Better Auth
(`/api/auth/*`), the AI queue consumer and realtime, all on one origin. Wrangler builds the web
app before `dev` and `deploy` (`build` in `wrangler.jsonc`) and serves it as static assets; the
Worker code runs first only for `/api/*`, `/health` and `/internal/*`, and any other unknown path
returns the app's `index.html` so deep links work. Its config is `apps/worker/wrangler.jsonc`;
every name and id there is a neutral default to replace with your own.

Bindings:

| Binding                                      | Kind                    | Setup                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE`                                 | Hyperdrive              | `wrangler hyperdrive create omni --connection-string=postgres://...`, then put the id in `wrangler.jsonc`. Locally, `localConnectionString` is the stack's Postgres.                                                                                                                                                 |
| `MAIL_BUCKET`                                | R2                      | The bucket the mail service writes raw mail and attachments to (`wrangler r2 bucket create <name>`). The Worker reads attachments from it and stores profile pictures and workspace logos under `pictures/`.                                                                                                         |
| `AI_QUEUE`                                   | Queue                   | `wrangler queues create omni-ai` and `wrangler queues create omni-ai-dlq`; the Worker produces and consumes both. Failed jobs land in the DLQ after `max_retries`, and the Worker's DLQ consumer records them in `dead_letters` (see [Observability](#observability)). A DLQ is the source queue's name plus `-dlq`. |
| `REPLAY_GUARD`                               | Durable Object (SQLite) | Created by the `migrations` block on first deploy. Remembers nonces of signed mail-service calls.                                                                                                                                                                                                                    |
| `REALTIME`                                   | Durable Object (SQLite) | Same migration. One per org; holds each open app's hibernatable websocket (`GET /api/realtime`).                                                                                                                                                                                                                     |
| `DOMAIN_ADD_LIMITER`, `DOMAIN_CHECK_LIMITER` | Rate limiting           | Nothing to create. Per-workspace limits on adding and checking domains (`ratelimits` in `wrangler.jsonc`); `namespace_id` must be unique in your account.                                                                                                                                                            |
| `DOMAIN_WATCH`                               | Durable Object (SQLite) | Migration `v2`. One per domain claim; re-checks DNS while the DNS page is open.                                                                                                                                                                                                                                      |
| `RATE_LIMITER`                               | Durable Object (SQLite) | Migration `v3`. One per rate-limit key (hashed); counts hits in a window, then clears itself. See [Rate limits](#rate-limits).                                                                                                                                                                                       |

Variables (`vars` in `wrangler.jsonc`, or the dashboard; `keep_vars` keeps dashboard values on
deploy) and secrets (`wrangler secret put <NAME>`). Locally, copy `apps/worker/.dev.vars.example`
to `.dev.vars`.

| Variable                     | Kind   | Required | Notes                                                                                                                                                                           |
| ---------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`         | secret | yes      | At least 32 random characters.                                                                                                                                                  |
| `BETTER_AUTH_URL`            | var    | yes      | Public origin of the Worker (and the web app it serves). Magic links point here.                                                                                                |
| `AUTH_TRUSTED_ORIGINS`       | var    | no       | Comma-separated web/app origins.                                                                                                                                                |
| `AUTH_PASSKEY_RP_ID`         | var    | no       | WebAuthn relying party ID.                                                                                                                                                      |
| `APP_NAME`                   | var    | no       | Defaults to `Omni`.                                                                                                                                                             |
| `WEB_APP_URL`                | var    | no       | Web app origin; invitation emails link to `<WEB_APP_URL>/invite/<id>`. Defaults to `BETTER_AUTH_URL`.                                                                           |
| `GOOGLE_CLIENT_ID`           | var    | no       | Google OAuth client ID. With `GOOGLE_CLIENT_SECRET`, the login page shows "Using Google". See [Sign in with Google](#sign-in-with-google).                                      |
| `GOOGLE_CLIENT_SECRET`       | secret | no       | Google OAuth client secret. Set both or neither; one alone stops the Worker from starting.                                                                                      |
| `MAIL_SERVICE_URL`           | var    | yes      | Base URL of the mail service; the Worker pings `POST /ping` on it.                                                                                                              |
| `MAIL_SERVICE_HMAC_SECRET`   | secret | yes      | Same value as the mail service's.                                                                                                                                               |
| `SYSTEM_MAIL_FROM`           | var    | no       | Address of a mailbox in Omni that sends magic links and invitations. Empty disables them.                                                                                       |
| `SENTRY_DSN`                 | var    | no       | Empty keeps Sentry off. Its environment tag is `ENVIRONMENT`.                                                                                                                   |
| `ANTHROPIC_API_KEY`          | secret | no       | Summaries, and triage when Jev is off. Without any AI key threads stay unsorted (a wordless reply of yours still files as FYI).                                                 |
| `TYPESAFE_API_KEY`           | secret | no       | Triage on TypeSafe's Jev, and search reordered by Jev's relevance judgment; summaries stay on Claude. Without it search keeps full-text order.                                  |
| `TRIAGE_PROVIDER`            | var    | no       | `jev` or `claude`; defaults to Jev when `TYPESAFE_API_KEY` is set.                                                                                                              |
| `JEV_MODEL`                  | var    | no       | Jev model override.                                                                                                                                                             |
| `TYPESAFE_API_URL`           | var    | no       | TypeSafe API base URL. Defaults to `https://api.typesafe.ai`.                                                                                                                   |
| `AI_DAILY_TOKEN_CAP`         | var    | no       | Tokens per org per UTC day (default 1,000,000). Over it, summaries pause.                                                                                                       |
| `EXPO_PUSH_ENABLED`          | var    | no       | `true` sends Expo push to members with no app open. Default `false`.                                                                                                            |
| `EXPO_ACCESS_TOKEN`          | secret | no       | Only if your Expo project enforces push security.                                                                                                                               |
| `DOMAIN_CONNECT_PROVIDER_ID` | var    | no       | Domain Connect provider id our templates are published under. Empty hides one-click setup.                                                                                      |
| `DOMAIN_CONNECT_KEY_HOST`    | var    | no       | TXT host of the public key, for templates that require signed requests.                                                                                                         |
| `DOMAIN_CONNECT_PRIVATE_KEY` | secret | no       | PKCS#8 PEM key that signs Domain Connect apply URLs.                                                                                                                            |
| `IMAGE_PROXY_DOH_URL`        | var    | no       | DNS-over-HTTPS (JSON) resolver the image proxy uses to refuse hosts that point at private addresses. Default Cloudflare's.                                                      |
| `ENVIRONMENT`                | var    | no       | `production` (default). `development` (local only) also logs magic-link and invitation URLs. `test` (e2e suites) is the only value that allows `IMAGE_PROXY_TEST_ALLOW_ORIGIN`. |

| `RATE_LIMIT_*` | var | no | Rate limits, `<count>/<seconds>` or `off`. See [Rate limits](#rate-limits). |
| `STRIPE_*`, `BILLING_*` | both | no | Optional billing. Leave unset to self-host with no plan and no limits. See [Billing](#billing-optional). |

The `triggers.crons` entry in `wrangler.jsonc` runs the domain re-check (ADR 0010); it needs no
setup beyond the deploy.

Magic links, invitations and domain notices are sent through the outbox: the Worker writes a `send` action for
the `SYSTEM_MAIL_FROM` mailbox and the mail service delivers it over SMTP, so that mailbox must be
connected like any other. Locally, `ENVIRONMENT=development` (the `.dev.vars.example` default)
also prints each link to the `wrangler dev` console as `{"event":"auth.dev_link",...}`, so you
can sign in without opening GreenMail. Those URLs sign you in: never set `development` in
production.

#### Sign in with Google

Optional. In the Google Cloud console, create an OAuth client of type "Web application" with
the authorized redirect URI `<BETTER_AUTH_URL>/api/auth/callback/google` (locally, with Vite,
`http://localhost:5173/api/auth/callback/google`). Set `GOOGLE_CLIENT_ID` as a var and
`GOOGLE_CLIENT_SECRET` as a secret. The login page asks `GET /api/sign-in-methods` and shows the
button only when both are set. Sign-up stays invitation-only: a Google account whose email has
no account and no pending invitation is sent back to `/login?error=SIGN_UP_REQUIRES_INVITATION`.
A Google account whose email matches an existing user signs in as that user only once that
user's email is verified (any magic-link sign-in verifies it); until then the callback returns
`?error=account_not_linked`.

#### Rate limits

The Worker limits the routes that send mail, call the mail service, fetch remote URLs (the
image proxy) or let someone guess at sign-in, in the `RATE_LIMITER` Durable Object (one
instance per key, so counts are exact). Each is a var of the form `<count>/<seconds>`; `off` disables it, empty means the default. Over a
limit the Worker answers `429` with `Retry-After`. Per-IP limits key on `CF-Connecting-IP`,
which Cloudflare sets and clients cannot.

| Variable                 | Default    | Counts                                                                                                                                                                        |
| ------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_AUTH`        | `60/60`    | Per IP: every sign-in step (magic link and its link, passkey options and verify, Google). Session reads are free.                                                             |
| `RATE_LIMIT_MAGIC_LINK`  | `5/900`    | Per email address: magic-link requests, so nobody can flood an inbox from your no-reply mailbox.                                                                              |
| `RATE_LIMIT_INVITE`      | `30/3600`  | Per inviting user: invitations sent or resent.                                                                                                                                |
| `RATE_LIMIT_SEARCH`      | `60/60`    | Per member: searches.                                                                                                                                                         |
| `RATE_LIMIT_SEND`        | `100/3600` | Per member: new mail and replies.                                                                                                                                             |
| `RATE_LIMIT_ACTIONS`     | `300/60`   | Per member: other writes that reach IMAP (read state, archive, move).                                                                                                         |
| `RATE_LIMIT_PROVISION`   | `30/3600`  | Per member: creating a mailbox, which calls the mail service. Adding and checking domains have their own per-workspace limits (`DOMAIN_ADD_LIMITER`, `DOMAIN_CHECK_LIMITER`). |
| `RATE_LIMIT_IMAGE_PROXY` | `300/60`   | Per member: image-proxy fetches of images not already cached (cached ones are free).                                                                                          |

#### Billing (optional)

Off unless `STRIPE_SECRET_KEY` is set. With it off there is no plan, no limit and no read-only
state: every workspace works as it always has. Hosted Omni turns it on; most self-hosters never
need to. When on, each workspace (organization) has one flat plan; people, inboxes and domains
are unlimited, and the only limit is a monthly allowance of AI-triaged emails. Past it, mail
keeps arriving and triage pauses until the next period. A workspace with no plan in good
standing is read-only: its mail syncs and reads, but nothing is sent or changed. See ADR 0015.

| Variable                   | Kind   | Required with billing | Notes                                                                                                          |
| -------------------------- | ------ | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`        | secret | turns it on           | Stripe secret key (`sk_test_…` in development).                                                                |
| `STRIPE_WEBHOOK_SECRET`    | secret | yes                   | Signing secret of the webhook endpoint below (`whsec_…`).                                                      |
| `STRIPE_PRICE_MONTHLY`     | var    | yes                   | Price id of the plan's monthly price. Amounts live in Stripe.                                                  |
| `STRIPE_PRICE_YEARLY`      | var    | no                    | Price id of the yearly price. Empty offers monthly only.                                                       |
| `STRIPE_PUBLISHABLE_KEY`   | var    | no                    | Publishable key (`pk_test_…`, same mode as the secret key). Owners add cards in the app; empty: in the portal. |
| `BILLING_TRIAL_DAYS`       | var    | no                    | Free trial length, once per workspace, no card needed. Empty or `0`: no trial.                                 |
| `BILLING_TRIAGE_ALLOWANCE` | var    | yes                   | AI-triaged emails per workspace per month. Rule-filed threads and threads with no AI key never count.          |

Set any of them without `STRIPE_SECRET_KEY` (or the key without the required ones) and the Worker
refuses to start, naming the variable.

Setup in Stripe:

1. Create a product with a recurring monthly price (and a yearly one if you offer it); put their
   ids in the price variables.
2. Add a webhook endpoint at `<BETTER_AUTH_URL>/api/auth/stripe/webhook` for
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`
   and `customer.subscription.deleted`; its signing secret is `STRIPE_WEBHOOK_SECRET`. Set the
   endpoint's API version to `2025-03-31` or later (the Stripe SDK Omni uses pins
   `2026-08-26.dahlia`): the billing period is read from each subscription item's
   `current_period_start` / `current_period_end`, which older versions do not send, and the
   plan's period dates would be stored as invalid dates.
3. Turn on the customer portal (Settings → Billing → Customer portal) so owners can switch
   interval and cancel. Saved cards and invoices are also in the app's Billing page, which reads
   them from Stripe; adding a card there needs `STRIPE_PUBLISHABLE_KEY` (Developers → API keys).

Locally, no webhook endpoint is registered in Stripe: the Stripe CLI forwards your sandbox's
events to the Worker. Its signing secret is `STRIPE_WEBHOOK_SECRET`. It has stayed the same
across runs for the same account and machine; if signatures start failing, print it again:

```bash
stripe listen --print-secret
```

Then keep this running next to `wrangler dev`:

```bash
stripe listen --forward-to localhost:8787/api/auth/stripe/webhook --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted
```

`stripe events resend <evt_id>` replays a real event; the Worker answers `applied: false` and
changes nothing.

#### Security headers

Every response carries HSTS (two years, subdomains included), `X-Content-Type-Options: nosniff`
and a Permissions-Policy that turns off unused browser features (passkeys stay on). The web
app's files get them from `apps/web/public/_headers`, which Cloudflare applies to static assets,
with a CSP that loads scripts, frames and connections only from your own origin. Worker answers
get them from `apps/worker/src/security-headers.ts`, with a deny-all CSP unless the route sets
its own (message HTML is sandboxed with scripts off). Serve Omni over HTTPS only: HSTS makes
browsers refuse plain http on that host for two years.

The mail service reports new and changed mail with a signed `POST /internal/mail-events`
(timestamp and nonce required; replays are rejected). Expose `/internal/*` only to it.

Sanitized mail HTML loads remote images through `GET /api/image-proxy?url=...` and inline
images and attachments through `GET /api/attachments/<sha256>`; the mail service writes those
paths (`IMAGE_PROXY_URL`, `ATTACHMENT_URL`). The proxy needs a signed-in member, fetches only
http(s) on standard ports, refuses private, loopback, link-local and metadata addresses on every
redirect hop (up to 3), and returns only raster images up to 5 MB within 8 s, cached for a day.

```bash
pnpm --filter @omni/worker dev      # wrangler dev on :8787 (we wrap it in Doppler)
pnpm --filter @omni/worker exec wrangler deploy
```

To work on the web app with hot reload, run the Worker with `BETTER_AUTH_URL` set to Vite's
origin (so magic links land on Vite), then Vite, which forwards `/api` to the Worker:

```bash
pnpm --filter @omni/worker dev --var BETTER_AUTH_URL:http://localhost:5173
pnpm --filter @omni/web dev         # http://localhost:5173
```

## Web app build (`apps/web`)

Built by Wrangler with the Worker; it needs no config. Optional build-time variables, documented
in `apps/web/.env.example` and validated by `vite.config.ts`:

| Variable                  | Required | Notes                                                                                   |
| ------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `VITE_SENTRY_DSN`         | no       | Sentry DSN for the browser. Unset keeps error reporting off. Ships in the bundle.       |
| `VITE_SENTRY_ENVIRONMENT` | no       | Sentry environment tag; defaults to `production`.                                       |
| `SENTRY_AUTH_TOKEN`       | no       | Secret. With `SENTRY_ORG` and `SENTRY_PROJECT`, the build uploads source maps to Sentry |
| `SENTRY_ORG`              | no       | and deletes them from `dist/`. Without all three the maps stay in the build and are     |
| `SENTRY_PROJECT`          | no       | served next to the bundle.                                                              |

## Observability

All three units are observable without any extra service; Sentry is optional everywhere.

- **Logs** are JSON lines: `time`, `level`, `event`, and where they apply `component`,
  `requestId`, `orgId`, `durationMs` and ids. Never message content, addresses or credentials;
  request lines carry the route pattern (`/api/threads/:id/reply`), not the URL. The Worker's go
  to Workers Logs (`observability` in `wrangler.jsonc`); the mail service's go to stdout.
- **Request IDs.** Every request gets one: the caller's `x-request-id` when it is 8-128 URL-safe
  characters (the web app sends a UUID per call), else a fresh one, echoed on the response. The
  Worker passes it to the mail service as `x-omni-request-id`, covered by the HMAC signature (a
  forged or stripped ID fails verification), and stores it on `mail_actions.request_id` and on
  AI queue jobs. Search either unit's logs for it to follow one action across processes.
- **Sentry** (`SENTRY_DSN`, `VITE_SENTRY_DSN`): errors only. The SDKs collect no headers,
  cookies, bodies, query strings or user info, and every event and breadcrumb is scrubbed of mail
  content, addresses and credentials before it leaves (`packages/mail-core/src/telemetry.ts`).
  Events are tagged with the request ID.
- **Dead letters**: AI jobs that used up their retries (`dead_letters`, written by the Worker's
  consumers) and outbox actions that failed for good (`mail_actions` with status `failed`), with
  their error and request ID, in one listing:

```bash
pnpm --filter @omni/mail dead-letters [--org <org id>] [--since 24h] [--limit 50] [--json]
# In the mail service's container image: node dist/dead-letters.js --since 24h
```

It needs `DATABASE_URL` and reads every org, so run it as an operator. It prints ids, errors and
request IDs, never payloads.
