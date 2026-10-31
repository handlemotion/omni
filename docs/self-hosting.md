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
cp apps/mail/.env.example apps/mail/.env
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

## Variables

Filled in per unit: see each unit's `.env.example`.

### Mail service (`apps/mail`)

The mail service is the only process that speaks IMAP and SMTP. It works with any standards-based
host. CONDSTORE and IDLE are used when the server offers them; without them it falls back to
UID-list diffs and polling. On every connect it logs the server's capabilities
(`imap.capabilities`).

| Variable                   | Required | Default  | Purpose                                                       |
| -------------------------- | -------- | -------- | ------------------------------------------------------------- |
| `MAIL_SERVICE_HMAC_SECRET` | yes      |          | Signs Worker → mail service pings; same value in the Worker.  |
| `MAIL_CREDENTIALS_KEY`     | yes      |          | 32-byte base64 AES-256-GCM key for stored mailbox passwords.  |
| `PORT`                     | no       | `8787`   | HTTP port for `/health` and `/ping`.                          |
| `LOG_LEVEL`                | no       | `info`   | `debug`, `info`, `warn`, or `error`. Logs are JSON on stdout. |
| `SYNC_INTERVAL_MS`         | no       | `300000` | Sync interval for non-inbox folders (INBOX is live via IDLE). |
| `OUTBOX_INTERVAL_MS`       | no       | `30000`  | Outbox poll interval when no ping arrives.                    |
| `MAILBOX_CONCURRENCY`      | no       | `4`      | Mailboxes connecting or syncing at once.                      |

Generate the secrets with `openssl rand -hex 32` and `openssl rand -base64 32`. Keep
`MAIL_CREDENTIALS_KEY` only on the mail service.

Run from source: `pnpm --filter @omni/mail start` reads `apps/mail/.env`. Variables already set
in the environment win over the file.

Run in Docker (any host that keeps one container always on):

```bash
docker build -f apps/mail/Dockerfile -t omni-mail .
docker run -d --restart unless-stopped --env-file apps/mail/.env -p 8787:8787 omni-mail
curl localhost:8787/health
```

The container runs as a non-root user. Point your host's health check at `GET /health`. It
handles `SIGTERM` gracefully: in-flight syncs and actions finish and mailboxes log out.
Expose `/ping` only to your Worker.
