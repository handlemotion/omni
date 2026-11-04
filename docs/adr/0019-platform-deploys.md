# 0019: Platforms deploy themselves; Actions migrates and syncs Worker secrets

Date: 2026-11-04 · Status: accepted · Amends: ADR 0004 (how the mail service is deployed)

## Context

`.github/workflows/deploy.yml` ran after CI on `main`: Drizzle migrations, then `flyctl deploy`
with every `prd_mail` key imported as a Fly secret, then `wrangler deploy` with every `prd_worker`
key as a Worker secret and `prd_github` values as vars. It bypassed both platforms' own GitHub
deploys, deploys never showed on a commit's checks (a `workflow_run` workflow runs against the
default branch), and secrets synced only when code shipped. Doppler now syncs `prd_mail` to Fly
itself; it has no automatic sync for Workers secrets (its Cloudflare Workers page is a DIY recipe).

## Decision

- **Worker: Cloudflare Workers Builds** deploys every push to `main` and posts a GitHub check run.
  Its deploy command is `apps/worker/scripts/deploy-cloudflare.mjs`, which fills this install's
  Hyperdrive id (a Hyperdrive binding requires its `id` in the config at deploy time), custom
  domains and `--var` values from build variables, so `wrangler.jsonc` keeps neutral defaults.
  Workers Builds ignores the config's `build` key, so its build command builds `apps/web`.
- **Mail service: Fly's GitHub deploy** of `main` with `apps/mail/fly.toml`.
- **Migrations stay in GitHub Actions** (`production.yml`, `drizzle-kit migrate` with
  `prd_github`'s `MIGRATE_DATABASE_URL`) on each push to `main`. Fly's `release_command` would
  gate the mail deploy on them, but Fly secrets are app-wide, so the admin role would sit in the
  always-on mail machine too; keeping it in CI keeps it out of every running service.
- **Actions also syncs Worker secrets** (`production.yml`): `prd_worker` to the Worker's secrets
  with `wrangler secret bulk`, on each push to `main` and by hand. Because that deploys a new
  version of the latest one, it first waits for the commit's platform check runs to finish, so it
  cannot put the previous code back.

## Consequences

- Nothing gates a deploy on CI any more; the `main` ruleset (green `Checks` before merge) is the
  gate.
- Nothing waits for the migrations: both platforms deploy as soon as `main` changes, so a
  migration can land after code that needs it. Additive-first schema changes (AGENTS.md) are now
  required, not just preferred.
- The Worker's build variables are a second copy of `prd_github`'s `HYPERDRIVE_ID`,
  `WORKER_DOMAIN` and `WORKER_VAR_*`. Syncing them from Doppler needs a token with Workers Builds
  access; until then both are changed together (docs/operations/doppler.md).
- Self-hosters can use the same setup on their own accounts, or run the deploy script and
  `flyctl deploy` themselves.
