# Doppler secrets

Project `omni`. Branch configs inherit from their environment's root config.

| Config       | Consumer                               | Holds                                                                                                                                                                                         |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | every local command (root)             | `DATABASE_URL` (local Docker), `MAIL_SERVICE_URL`, `MAIL_SERVICE_HMAC_SECRET`, GreenMail host/ports                                                                                           |
| `dev_mail`   | `apps/mail` locally                    | `MAIL_CREDENTIALS_KEY` (AES-256-GCM, base64 32 bytes)                                                                                                                                         |
| `dev_worker` | `apps/worker` locally (`wrangler dev`) | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY`, `ENVIRONMENT=development`, Stripe sandbox billing (`STRIPE_*`, `BILLING_*`; webhook secret from `stripe listen --print-secret`) |
| `prd_mail`   | Fly.io mail service (`omni-mail`)      | `DATABASE_URL`, `MAIL_CREDENTIALS_KEY`, `MAIL_SERVICE_HMAC_SECRET`, `WORKER_URL`, `S3_*` (R2), optional `PURELYMAIL_API_TOKEN`                                                                |
| `prd_worker` | Cloudflare Worker secrets              | `BETTER_AUTH_SECRET`, `MAIL_SERVICE_HMAC_SECRET`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                               |
| `prd_github` | `production.yml`, records              | `MIGRATE_DATABASE_URL`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WORKER_DOMAIN`; kept as records: `HYPERDRIVE_ID`, `HYPERDRIVE_ORIGIN_URL`, `WORKER_VAR_*`                           |

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
- A key is either a Worker secret (`prd_worker`) or a Worker var (`WORKER_VAR_*`), never both: a
  name that `wrangler.jsonc` defines as a var cannot also be a secret (Cloudflare refuses the
  second binding). Public values such as `STRIPE_PUBLISHABLE_KEY` are vars.
- Check presence by name only: `doppler secrets -p omni -c <config> --only-names`.

## Production deploys

Each platform deploys `main` itself (ADR 0019). GitHub Actions (`.github/workflows/production.yml`)
does the two things the platforms can't, on each push to `main` and by hand (Actions → Production
→ Run). Doppler's GitHub sync copies `prd_github` into the secrets of the GitHub environment
`production` (only jobs that declare it can read them). `prd_worker` is read at run time with a
read-only service token, `DOPPLER_TOKEN_WORKER`, so exactly its keys become Worker secrets.

- **Migrations** run with `prd_github`'s `MIGRATE_DATABASE_URL`, so the admin role is in no
  running service. Nothing waits for them (both platforms deploy as soon as `main` changes), so
  schema changes stay additive-first (AGENTS.md): the schema lands in an earlier PR than the code
  that needs it.
- **Worker secrets**: every key in `prd_worker` becomes a Worker secret, after that commit's
  Cloudflare build finishes. Removing a key here does not delete the Worker secret; delete it with
  `wrangler secret delete`.
- **Worker: Cloudflare Workers Builds.** Build `pnpm --filter @omni/web build`, deploy
  `pnpm --filter @omni/worker deploy:cloudflare` (`apps/worker/scripts/deploy-cloudflare.mjs`),
  root `/`, previews off. Its build variables hold this install's values: `HYPERDRIVE_ID`
  replaces the placeholder id, `WORKER_DOMAIN` lists the custom domains, and `WORKER_VAR_<NAME>`
  becomes the Worker var `<NAME>` (over the neutral default in `wrangler.jsonc`). They were
  copied from `prd_github`; change both when one changes (`cf builds triggers
  environment-variables upsert <trigger-uuid> --body '{...}'`). Build variables reach only the
  build, never the running Worker.
- **Mail service: Fly's GitHub deploy** of `main`, working directory the repo root, config
  `apps/mail/fly.toml`. Doppler's Fly integration syncs `prd_mail` to the app's secrets.
- Database roles (PlanetScale `omni`, branch `main`): `MIGRATE_DATABASE_URL` is an admin role used
  only by the migrate job; the mail service and Hyperdrive (`HYPERDRIVE_ORIGIN_URL`, kept to
  recreate the config) each have a read/write role.
