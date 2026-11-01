# 0004: Run the mail service on Fly.io

Date: 2026-10-31 · Status: accepted · Supersedes [0001](0001-railway-for-mail-service.md)

## Context

ADR 0001 moved the always-on mail service from Fly.io (the spec's choice) to Railway. Railway has
since closed new signups, so we cannot create the account the service would run in. The service
is unchanged: one long-lived Node process holding IMAP IDLE connections, built from
`apps/mail/Dockerfile`, reaching PlanetScale Postgres and R2 over the internet.

## Decision

Run `apps/mail` as one Fly.io app with a single always-on machine on the smallest shared-CPU size,
in the region closest to the database (`iad`, next to PlanetScale `us-east`). Config is
`apps/mail/fly.toml`. CI deploys it from `main` with `flyctl deploy`; secrets come from Doppler
config `prd_mail` and are imported with `flyctl secrets import` before each deploy.

The database stays PlanetScale Postgres. Fly Postgres is not used.

## Why

- It is what the spec chose, and its cost at our size (a few dollars a month) fits the budget.
- Fly restarts crashed machines, health-checks them, and deploys a Dockerfile with no
  platform-specific code.
- The Dockerfile already runs on any host, so the switch is config only.

## Consequences

- The spec's "Fly.io" lines hold again; ADR 0001 no longer applies.
- Auto-stop is off and one machine always runs: IDLE connections die with a stopped machine.
- Only HTTPS (`/health`, signed `/ping`) is public, on the app's Fly hostname. IMAP and SMTP are
  outbound connections; no mail port is exposed.
- A second machine would open duplicate IDLE connections and race on the outbox, so the app
  never scales past one machine until the service gains leader election.
