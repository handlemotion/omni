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
