# 0001: Run the mail service on Railway, not Fly.io

Date: 2026-10-31 · Status: accepted

## Context

The spec (`docs/spec/v1.md`) puts the always-on mail service on one Fly.io machine. The mail
service needs one long-lived process that holds IMAP IDLE connections all day, restarts itself on
crash, and reaches PlanetScale Postgres and R2 over the internet.

## Decision

Run `apps/mail` as one always-on Railway service, built from the repo's Dockerfile and deployed
from `main`. Secrets come from Doppler config `prd_mail` through Doppler's Railway integration.

## Why

- Rodrigo already prefers and runs Railway; one less platform to operate.
- Cost is equivalent at our size: a small Node process idling on IMAP sockets costs a few dollars a
  month on either platform, inside the spec's $25 budget.
- Railway restarts crashed services and deploys from GitHub without a custom CI step.

## Consequences

- Everything in the spec that says "Fly.io" means Railway.
- The mail service exposes one private HTTPS route (HMAC-signed) on its Railway domain for the
  Worker's pings. Nothing else is public.
- If Railway ever limits outbound IMAP or long-lived sockets, Fly.io is the fallback: the service
  is a plain container with no Railway-specific code.
