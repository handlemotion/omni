# Doppler secrets

Project `omni`. Branch configs inherit from their environment's root config.

| Config       | Consumer                               | Holds                                                                                                                                                               |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`        | every local command (root)             | `DATABASE_URL` (local Docker), `MAIL_SERVICE_URL`, `MAIL_SERVICE_HMAC_SECRET`, GreenMail host/ports                                                                 |
| `dev_mail`   | `apps/mail` locally                    | `MAIL_CREDENTIALS_KEY` (AES-256-GCM, base64 32 bytes)                                                                                                               |
| `dev_worker` | `apps/worker` locally (`wrangler dev`) | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY`, `ENVIRONMENT=development`                                                                             |
| `prd_mail`   | Fly.io mail service (`omni-mail`)      | `DATABASE_URL`, `MAIL_CREDENTIALS_KEY`, `MAIL_SERVICE_HMAC_SECRET`, `WORKER_URL`, `S3_*` (R2), optional `PURELYMAIL_API_TOKEN`                                      |
| `prd_worker` | Cloudflare Worker secrets              | `BETTER_AUTH_SECRET`, `MAIL_SERVICE_HMAC_SECRET`, `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`                                                                           |
| `prd_github` | Deploy workflow (`deploy.yml`)         | `MIGRATE_DATABASE_URL`, `FLY_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `HYPERDRIVE_ID`, `HYPERDRIVE_ORIGIN_URL`, `WORKER_DOMAIN`, `WORKER_VAR_*` |

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

`.github/workflows/deploy.yml` runs on `main` after CI passes: migrate, then the mail service and
the Worker. It reads Doppler through three read-only service tokens, one per config, stored as
secrets of the GitHub environment `production`: `DOPPLER_TOKEN_GITHUB` (`prd_github`),
`DOPPLER_TOKEN_MAIL` (`prd_mail`), `DOPPLER_TOKEN_WORKER` (`prd_worker`).

- Every key in `prd_mail` is imported as a Fly secret on each deploy.
- Every key in `prd_worker` is uploaded as a Worker secret on each deploy. Removing a key here
  does not delete the Worker secret; delete it with `wrangler secret delete`.
- `prd_github` holds deploy-time config. `WORKER_VAR_<NAME>` becomes the Worker var `<NAME>`
  (overriding the neutral default in `wrangler.jsonc`), for example `WORKER_VAR_BETTER_AUTH_URL`
  and `WORKER_VAR_MAIL_SERVICE_URL`. `HYPERDRIVE_ID` replaces the placeholder id and
  `WORKER_DOMAIN` is the Worker's custom domain, or several comma-separated (the first is
  health-checked after deploy).
- Database roles (PlanetScale `omni`, branch `main`): `MIGRATE_DATABASE_URL` is an admin role used
  only by migrations; the mail service and Hyperdrive (`HYPERDRIVE_ORIGIN_URL`, kept to recreate
  the config) each have a read/write role.
