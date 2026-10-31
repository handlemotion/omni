# Doppler secrets

Project `omni`. Branch configs inherit from their environment's root config.

| Config       | Consumer                               | Holds                                                                                               |
| ------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `dev`        | every local command (root)             | `DATABASE_URL` (local Docker), `MAIL_SERVICE_URL`, `MAIL_SERVICE_HMAC_SECRET`, GreenMail host/ports |
| `dev_mail`   | `apps/mail` locally                    | `MAIL_CREDENTIALS_KEY` (AES-256-GCM, base64 32 bytes)                                               |
| `dev_worker` | `apps/worker` locally (`wrangler dev`) | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ANTHROPIC_API_KEY`                                        |
| `prd_mail`   | Railway mail service                   | prod DB URL, `MAIL_CREDENTIALS_KEY`, `PURELYMAIL_API_TOKEN`, HMAC secret, R2 keys, Sentry DSN       |
| `prd_worker` | Cloudflare Worker secrets              | `BETTER_AUTH_SECRET`, HMAC secret, `ANTHROPIC_API_KEY`, Sentry DSN                                  |
| `prd_github` | GitHub Actions secrets                 | `CLOUDFLARE_API_TOKEN`, deploy tokens                                                               |

Rules:

- `MAIL_CREDENTIALS_KEY` and `PURELYMAIL_API_TOKEN` exist only in `*_mail` configs. The Worker can
  never decrypt mailbox credentials.
- `MAIL_SERVICE_HMAC_SECRET` must be identical in a pair of `*_mail` / `*_worker` configs. In
  `dev` it lives in the root config so both inherit it.
- Local: `doppler run -p omni -c dev_<unit> -- <command>`. Headless: set `DOPPLER_TOKEN` to a
  service token scoped to one config.
- Check presence by name only: `doppler secrets -p omni -c <config> --only-names`.
