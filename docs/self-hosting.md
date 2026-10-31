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
