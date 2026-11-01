# Self-hosting Omni

Status: draft. Each unit adds its required services, bindings, and variables here as it lands.

## What you need

- A Cloudflare account (Workers Paid for Queues and Durable Objects, R2).
- A Postgres database reachable from Cloudflare Hyperdrive and from the mail service.
- One always-on container host for `apps/mail` (we use Railway; any Docker host works).
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

| Variable               | Used by                         | Required | Notes                                                                   |
| ---------------------- | ------------------------------- | -------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`         | migrations, mail service, tests | yes      | `postgres://` URL. The Worker reaches the same database via Hyperdrive. |
| `BETTER_AUTH_SECRET`   | Worker (auth)                   | yes      | At least 32 random characters.                                          |
| `BETTER_AUTH_URL`      | Worker (auth)                   | yes      | Public origin of the API.                                               |
| `AUTH_TRUSTED_ORIGINS` | Worker (auth)                   | no       | Comma-separated web/app origins allowed to call auth.                   |
| `AUTH_PASSKEY_RP_ID`   | Worker (auth)                   | no       | WebAuthn relying party ID; defaults to the `BETTER_AUTH_URL` host.      |
| `APP_NAME`             | Worker (auth)                   | no       | Shown in passkey prompts; defaults to `Omni`.                           |

### Mail service (`apps/mail`)

The mail service is the only process that speaks IMAP and SMTP. It works with any standards-based
host. CONDSTORE and IDLE are used when the server offers them; without them it falls back to
UID-list diffs and polling. On every connect it logs the server's capabilities
(`imap.capabilities`).

| Variable                   | Required | Default            | Purpose                                                       |
| -------------------------- | -------- | ------------------ | ------------------------------------------------------------- |
| `MAIL_SERVICE_HMAC_SECRET` | yes      |                    | Signs Worker → mail service pings; same value in the Worker.  |
| `DATABASE_URL`             | yes      |                    | Postgres the service writes the mail index to.                |
| `MAIL_CREDENTIALS_KEY`     | yes      |                    | Keyring `k1:<base64 32 bytes>[,k0:...]`, current key first.   |
| `S3_ENDPOINT`              | yes      |                    | S3 API endpoint: R2, MinIO, AWS, or the local gateway.        |
| `S3_BUCKET`                | yes      |                    | Bucket for raw mail, sanitized HTML and attachments.          |
| `S3_ACCESS_KEY_ID`         | yes      |                    | S3 key pair (for R2: an R2 API token with object read/write). |
| `S3_SECRET_ACCESS_KEY`     | yes      |                    |                                                               |
| `S3_REGION`                | no       | `auto`             | Signing region; R2 uses `auto`.                               |
| `IMAGE_PROXY_URL`          | no       | `/api/image-proxy` | Worker image proxy that remote images in HTML go through.     |
| `ATTACHMENT_URL`           | no       | `/api/attachments` | Worker route for inline `cid:` images.                        |
| `PORT`                     | no       | `8788`             | HTTP port for `/health` and `/ping`.                          |
| `LOG_LEVEL`                | no       | `info`             | `debug`, `info`, `warn`, or `error`. Logs are JSON on stdout. |
| `SYNC_INTERVAL_MS`         | no       | `300000`           | Sync interval for non-inbox folders (INBOX is live via IDLE). |
| `OUTBOX_INTERVAL_MS`       | no       | `30000`            | Outbox poll interval when no ping arrives.                    |
| `MAILBOX_CONCURRENCY`      | no       | `4`                | Mailboxes connecting or syncing at once.                      |

Generate the secrets with `openssl rand -hex 32` and `echo "k1:$(openssl rand -base64 32)"`.
Keep `MAIL_CREDENTIALS_KEY` only on the mail service. To rotate it, put the new key first
(`k2:<new>,k1:<old>`); stored credentials still decrypt by their key id.

On start the service connects every mailbox whose status is not `disabled` and resumes each
folder from its saved sync position. A signed ping, or the next sync interval, picks up
mailboxes added later.

The Worker and the mail service call each other over HMAC-signed HTTP (`@omni/crypto`, 60 s
window). The Worker pings `POST /ping` after writing to the outbox or adding a mailbox; the mail
service posts batches of `message.created` events to the Worker after indexing new mail. Paths
and bodies are defined once in `packages/contracts`.

Objects are keyed by content hash under `<org id>/<mailbox id>/` (`raw/<sha256>.eml`,
`html/<sha256>.html`, `att/<sha256>`), so a re-sync rewrites the same keys. The local stack runs
[Versity S3 Gateway](https://github.com/versity/versitygw) on `localhost:7070` with the bucket
`omni-mail-dev` already created.

### Adding a mailbox

Mailboxes are added from the command line with the same `DATABASE_URL` and
`MAIL_CREDENTIALS_KEY` as the service. The owner must already be a member of the organization
(sign in once). The app password is read from stdin so it never lands in shell history:

```bash
# Any IMAP/SMTP host
printf '%s' "$APP_PASSWORD" | pnpm --filter @omni/mail mailbox:add -- \
  --org <org id> --address you@example.com --owner you@example.com \
  --provider imap --imap imap.example.com:993 --smtp smtp.example.com:465

# Purelymail: servers are known; optionally let its API create the app password
pnpm --filter @omni/mail mailbox:add -- --org <org id> --address you@example.com \
  --owner you@example.com --create-app-password      # needs PURELYMAIL_API_TOKEN
```

In the Docker image the same CLI is `node dist/mailbox-add.js` (for example
`docker run -i --rm --env-file apps/mail/.env omni-mail node dist/mailbox-add.js --org ...`).

It checks the IMAP login (`--no-verify` skips that), encrypts the credentials bound to the
mailbox id, stores the mailbox with an owner grant, and prints the mailbox id. Running it again
for the same address replaces the credentials. With `MAIL_SERVICE_URL` set it pings the running
service, which connects the mailbox immediately; otherwise it is picked up on the next sync
interval. `--kind shared` adds a shared inbox (read state stays per person; `\Seen` is never
changed on the server).

Run from source: `pnpm --filter @omni/mail start` reads `apps/mail/.env`. Variables already set
in the environment win over the file.

Run in Docker (any host that keeps one container always on):

```bash
docker build -f apps/mail/Dockerfile -t omni-mail .
docker run -d --restart unless-stopped --env-file apps/mail/.env -p 8788:8788 omni-mail
curl localhost:8788/health
```

The container runs as a non-root user. Point your host's health check at `GET /health`. It
handles `SIGTERM` gracefully: in-flight syncs and actions finish and mailboxes log out.
Expose `/ping` only to your Worker.

### Worker (`apps/worker`)

One Cloudflare Worker serves the API (`/api/*`), Better Auth (`/api/auth/*`) and, as later
sections add, the AI queue consumer and realtime. Its config is `apps/worker/wrangler.jsonc`;
every name and id there is a neutral default to replace with your own.

Bindings:

| Binding       | Kind       | Setup                                                                                                                                                                |
| ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE`  | Hyperdrive | `wrangler hyperdrive create omni --connection-string=postgres://...`, then put the id in `wrangler.jsonc`. Locally, `localConnectionString` is the stack's Postgres. |
| `MAIL_BUCKET` | R2         | The bucket the mail service writes raw mail and attachments to (`wrangler r2 bucket create <name>`). The Worker only reads attachments from it.                      |

Variables (`vars` in `wrangler.jsonc`, or the dashboard; `keep_vars` keeps dashboard values on
deploy) and secrets (`wrangler secret put <NAME>`). Locally, copy `apps/worker/.dev.vars.example`
to `.dev.vars`.

| Variable                   | Kind   | Required | Notes                                                                     |
| -------------------------- | ------ | -------- | ------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`       | secret | yes      | At least 32 random characters.                                            |
| `BETTER_AUTH_URL`          | var    | yes      | Public origin of the Worker.                                              |
| `AUTH_TRUSTED_ORIGINS`     | var    | no       | Comma-separated web/app origins.                                          |
| `AUTH_PASSKEY_RP_ID`       | var    | no       | WebAuthn relying party ID.                                                |
| `APP_NAME`                 | var    | no       | Defaults to `Omni`.                                                       |
| `MAIL_SERVICE_URL`         | var    | yes      | Base URL of the mail service; the Worker pings `POST /ping` on it.        |
| `MAIL_SERVICE_HMAC_SECRET` | secret | yes      | Same value as the mail service's.                                         |
| `SYSTEM_MAIL_FROM`         | var    | no       | Address of a mailbox in Omni that sends magic links. Empty disables them. |
| `SENTRY_DSN`               | var    | no       | Empty keeps Sentry off.                                                   |

Magic links are sent through the outbox: the Worker writes a `send` action for the
`SYSTEM_MAIL_FROM` mailbox and the mail service delivers it over SMTP, so that mailbox must be
connected like any other.

```bash
pnpm --filter @omni/worker dev      # wrangler dev on :8787 (we wrap it in Doppler)
pnpm --filter @omni/worker exec wrangler deploy
```
