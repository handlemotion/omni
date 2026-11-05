# Claude Code cloud sessions

Cloud sessions (claude.ai/code) run Omni with the full local stack: Postgres, GreenMail and the
S3 gateway from `compose.yml`, the database migrated, and Doppler `dev` secrets in the usual local
env files. Two files do the work:

- `scripts/cloud/setup.sh`: the environment's setup script. Machine tools only (Node from
  `.nvmrc`, pnpm from `packageManager`, `doppler`, `cf`, `flyctl`, `psql`) and the
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
   plus these hosts: `api.doppler.com` (Doppler), `api.cloudflare.com` (`cf`, `wrangler`),
   `api.fly.io` (`flyctl`), `*.tailscale.com` and `acme-v02.api.letsencrypt.org` (`pnpm share`).
   Without Doppler the stack still runs with the example env files; without the rest only those
   tools stop working.
3. **Environment variables**: read-only Doppler service tokens, one per config, like
   `production.yml`. Create each in Doppler under project `omni` → config → Access → Service Tokens.

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
`doppler run -c dev_<unit>`, which a token scoped to another config cannot read.

## Share a running server

`pnpm share` (`scripts/share.mjs`) gives a server in the session a private HTTPS URL that opens in
a browser on any of your devices signed in to your Tailscale network, and nowhere else:

```bash
pnpm share          # the Omni stack: runs `pnpm stack:serve` with auth on the shared URL
pnpm share 5173     # any local server, at https://<machine>.<tailnet>.ts.net:5173/
pnpm share status
pnpm share stop     # also takes the machine off the tailnet
```

Each session joins as its own machine, `omni-<session id>`, so every session has a new URL. The
script downloads a pinned Tailscale into `.local/tailscale` and runs its own `tailscaled` in
userspace mode: it accepts the shared ports and cannot open connections into your tailnet. The
egress proxy carries Tailscale; ngrok and Cloudflare quick tunnels cannot connect from here.

For the Omni stack, the Worker takes the shared URL as `BETTER_AUTH_URL` and `WEB_APP_URL` and
still trusts `localhost`, so magic links (logged as `auth.dev_link` in `.local/serve/worker.log`)
and passkeys work on the shared URL. The session hook lets Vite dev servers answer on `.ts.net`
names (`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`).

One-time setup, in the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS**: turn on MagicDNS and HTTPS Certificates.
2. **Access controls**: add the tag, and let your devices reach machines that carry it:

   ```json
   "tagOwners": { "tag:omni-cloud": ["autogroup:admin"] },
   "grants": [{ "src": ["autogroup:member"], "dst": ["tag:omni-cloud"], "ip": ["*"] }]
   ```

   Grant nothing with `tag:omni-cloud` as its source (the session cannot dial out anyway).

3. **Settings → OAuth clients**: create a client with the Auth Keys write scope and tag
   `tag:omni-cloud`. Store its secret as `TS_AUTHKEY` in Doppler `omni` / `dev` (the session reads
   it with `DOPPLER_TOKEN`), or as a `TS_AUTHKEY` environment variable on the cloud environment.
   OAuth client secrets do not expire; machines they add are ephemeral and leave the tailnet soon
   after the session ends.

Without `TS_AUTHKEY`, `pnpm share` prints a login link instead: open it, approve the machine, and
run it again. A machine added that way is yours, not tagged or ephemeral; remove it in the admin
console when the session is done.
