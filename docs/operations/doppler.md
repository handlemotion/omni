# Doppler secrets

Project `omni`. Branch configs inherit from their environment's root config.

| Config       | Consumer                               | Holds                                                                                                                                                                                         |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | every local command (root)             | `DATABASE_URL` (local Docker), `MAIL_SERVICE_URL`, `MAIL_SERVICE_HMAC_SECRET`, GreenMail host/ports                                                                                           |
| `dev_mail`   | `apps/mail` locally                    | `MAIL_CREDENTIALS_KEY` (AES-256-GCM, base64 32 bytes)                                                                                                                                         |
| `dev_worker` | `apps/worker` locally (`wrangler dev`) | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY`, `ENVIRONMENT=development`, Stripe sandbox billing (`STRIPE_*`, `BILLING_*`; webhook secret from `stripe listen --print-secret`) |
| `prd_mail`   | Fly.io mail service (`omni-mail`)      | `DATABASE_URL`, `MIGRATE_DATABASE_URL`, `MAIL_CREDENTIALS_KEY`, `MAIL_SERVICE_HMAC_SECRET`, `WORKER_URL`, `S3_*` (R2), optional `PURELYMAIL_API_TOKEN`                                        |
| `prd_worker` | Cloudflare Worker secrets              | `BETTER_AUTH_SECRET`, `MAIL_SERVICE_HMAC_SECRET`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`                                                                                                     |
| `prd_github` | `sync-worker-secrets.yml`, records     | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WORKER_DOMAIN`; kept as records: `HYPERDRIVE_ID`, `HYPERDRIVE_ORIGIN_URL`, `WORKER_VAR_*`                                                   |

Rules:

- `MAIL_CREDENTIALS_KEY` and `PURELYMAIL_API_TOKEN` exist only in `*_mail` configs. The Worker can
  never decrypt mailbox credentials.
- `MAIL_SERVICE_HMAC_SECRET` must be identical in a pair of `*_mail` / `*_worker` configs. In
  `dev` it lives in the root config so both inherit it.
- Local: `doppler run -p omni -c dev_<unit> -- <command>`. Headless: set `DOPPLER_TOKEN` to a
  service token scoped to one config.
- `wrangler dev` ignores process variables, so the Worker's `dev` script mounts the config as
  `apps/worker/.dev.vars` instead (`doppler run --mount .dev.vars --format env`). The mount is a
  named pipe that Doppler serves from memory and deletes on exit: nothing is written to disk, and
  only the config's keys become bindings. The command refuses to start while a `.dev.vars` file
  exists (your own copy, or a pipe left by a killed run); move or delete it first.
- Check presence by name only: `doppler secrets -p omni -c <config> --only-names`.

## Production deploys

Each platform deploys `main` itself (ADR 0019); GitHub Actions only syncs the Worker's secrets.

- **Worker: Cloudflare Workers Builds.** Build `pnpm --filter @omni/web build`, deploy
  `pnpm --filter @omni/worker deploy:cloudflare` (`apps/worker/scripts/deploy-cloudflare.mjs`),
  root `/`, previews off. Its build variables hold this install's values: `HYPERDRIVE_ID`
  replaces the placeholder id, `WORKER_DOMAIN` lists the custom domains, and `WORKER_VAR_<NAME>`
  becomes the Worker var `<NAME>` (over the neutral default in `wrangler.jsonc`). They were
  copied from `prd_github`; change both when one changes (`cf builds triggers
  environment-variables upsert <trigger-uuid> --body '{...}'`). Build variables reach only the
  build, never the running Worker.
- **Worker secrets: `.github/workflows/sync-worker-secrets.yml`**, on each push to `main` (after
  that commit's Cloudflare build finishes) and by hand (Actions → Sync Worker secrets → Run).
  Every key in `prd_worker` becomes a Worker secret. Removing a key here does not delete the
  Worker secret; delete it with `wrangler secret delete`. It reads Doppler through read-only
  service tokens kept as secrets of the GitHub environment `production`: `DOPPLER_TOKEN_GITHUB`
  (`prd_github`) and `DOPPLER_TOKEN_WORKER` (`prd_worker`).
- **Mail service: Fly's GitHub deploy** of `main`, working directory the repo root, config
  `apps/mail/fly.toml`. Doppler's Fly integration syncs `prd_mail` to the app's secrets.
  `release_command` applies the database migrations before the new version replaces the running
  one, and a failed migration stops the deploy.
- The two platforms deploy independently, so a migration can land after the Worker's new code.
  Schema changes stay additive-first (AGENTS.md): the schema lands in an earlier PR than the code
  that needs it.
- Database roles (PlanetScale `omni`, branch `main`): `MIGRATE_DATABASE_URL` is an admin role used
  only by migrations (in `prd_mail`, for the release command); the mail service and Hyperdrive
  (`HYPERDRIVE_ORIGIN_URL`, kept to recreate the config) each have a read/write role.
