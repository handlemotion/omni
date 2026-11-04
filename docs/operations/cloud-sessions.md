# Claude Code cloud sessions

Cloud sessions (claude.ai/code) run Omni with the full local stack: Postgres, GreenMail and the
S3 gateway from `compose.yml`, the database migrated, and Doppler `dev` secrets in the usual local
env files. Two files do the work:

- `scripts/cloud/setup.sh`: the environment's setup script. Machine tools only (Node from
  `.nvmrc`, pnpm from `packageManager`, `doppler`, `cf`, `flyctl`, `psql`, `devtunnel`) and the
  compose images. Claude Code snapshots the result, so it reads no secrets and leaves nothing
  running.
- `.claude/hooks/cloud-session-start.sh`: a SessionStart hook that exits at once unless
  `CLAUDE_CODE_REMOTE=true`, which Claude Code sets only in cloud sessions. It puts Node and
  pnpm from `/opt/node/bin` first on PATH (running `setup.sh` itself, about 20 s, when the
  environment's setup script did not install the `.nvmrc` version), starts dockerd, runs
  `pnpm install --frozen-lockfile` and `pnpm stack:up`, writes env files from Doppler, and runs
  `db:migrate`. Its log is `/tmp/omni-session-start.log`.

## Set up the environment

In claude.ai, open the environment settings for `handlemotion/omni`:

1. **Setup script**: paste `scripts/cloud/setup.sh` as it is on `main`. Re-paste it whenever the
   file changes; the snapshot rebuilds when the script does.
2. **Network access**: Custom, with "Also include default list of common package managers" on,
   plus these hosts: `api.doppler.com` (Doppler), `aka.ms` and
   `tunnelsassetsprod.blob.core.windows.net` (devtunnel download), `*.devtunnels.ms` (sharing a
   port), `api.cloudflare.com` (`cf`, `wrangler`), `api.fly.io` (`flyctl`). Without Doppler the
   stack still runs with the example env files; without the rest only those tools stop working.
3. **Environment variables**: read-only Doppler service tokens, one per config, like
   `deploy.yml`. Create each in Doppler under project `omni` → config → Access → Service Tokens.

| Variable               | Doppler config | Written to              | Needed for                   |
| ---------------------- | -------------- | ----------------------- | ---------------------------- |
| `DOPPLER_TOKEN`        | `dev`          | `packages/db/.env`      | `doppler run -- <command>`   |
| `DOPPLER_TOKEN_MAIL`   | `dev_mail`     | `apps/mail/.env`        | running `apps/mail`          |
| `DOPPLER_TOKEN_WORKER` | `dev_worker`   | `apps/worker/.dev.vars` | `wrangler dev` (and AI keys) |

Each file is the unit's example file with the config's values on top. All three are optional and
`dev`-scoped only: never put a `prd_*` token in a cloud environment. The hook never prints a
value, and it rewrites only files it wrote itself.

In a session, run units with their plain commands (`pnpm --filter @omni/mail start`,
`pnpm --filter @omni/worker exec wrangler dev`) rather than the `dev` scripts: those call
`doppler run -c dev_<unit>`, which a token scoped to another config cannot read. Share a running
port with `devtunnel host -p 8787` after `devtunnel user login`.
