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
pnpm stack:up                         # Postgres + GreenMail
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

| Variable                   | Required | Default  | Purpose                                                       |
| -------------------------- | -------- | -------- | ------------------------------------------------------------- |
| `MAIL_SERVICE_HMAC_SECRET` | yes      |          | Signs Worker → mail service pings; same value in the Worker.  |
| `DATABASE_URL`             | yes      |          | Postgres the service writes the mail index to.                |
| `MAIL_CREDENTIALS_KEY`     | yes      |          | Keyring `k1:<base64 32 bytes>[,k0:...]`, current key first.   |
| `PORT`                     | no       | `8788`   | HTTP port for `/health` and `/ping`.                          |
| `LOG_LEVEL`                | no       | `info`   | `debug`, `info`, `warn`, or `error`. Logs are JSON on stdout. |
| `SYNC_INTERVAL_MS`         | no       | `300000` | Sync interval for non-inbox folders (INBOX is live via IDLE). |
| `OUTBOX_INTERVAL_MS`       | no       | `30000`  | Outbox poll interval when no ping arrives.                    |
| `MAILBOX_CONCURRENCY`      | no       | `4`      | Mailboxes connecting or syncing at once.                      |

Generate the secrets with `openssl rand -hex 32` and `echo "k1:$(openssl rand -base64 32)"`.
Keep `MAIL_CREDENTIALS_KEY` only on the mail service. To rotate it, put the new key first
(`k2:<new>,k1:<old>`); stored credentials still decrypt by their key id.

On start the service connects every mailbox whose status is not `disabled` and resumes each
folder from its saved sync position. A signed ping, or the next sync interval, picks up
mailboxes added later.

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
