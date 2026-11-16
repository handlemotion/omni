# 0042: The app lives at the root domain

Date: 2026-11-16 · Status: accepted · Amends: ADR 0006 ("Domains"), spec v1 (open question on the
app's domain)

## Context

ADR 0006 put the web app on `inbox.omnidirectional.app` and kept the bare domain free for a
marketing site. The mail service reaches the Worker on a second host, `api.omnidirectional.app`.
No marketing site exists, the bare domain serves nothing, and the MCP spec already names
`https://omnidirectional.app/mcp`. The founder asked on 2026-11-16 for the app to live at the root
domain with no subdomains, and for the marketing site to wait.

The code already takes every host from config (`BETTER_AUTH_URL`, `AUTH_TRUSTED_ORIGINS`,
`WORKER_DOMAIN`, the mail service's `WORKER_URL`), and stored mail HTML links to the Worker by
path (`/api/image-proxy`, `/api/attachments`), so moving hosts is a config change.

## Decision

1. Hosted Omni serves everything from `omnidirectional.app`: the web app, `/api`, `/mcp`,
   `/.well-known/*` and the mail service's `/internal/*` calls. `inbox.` and `api.` retire.
2. The marketing site is deferred. When it comes it must not take `/` from the app; where it goes
   is decided then.
3. The passkey relying party ID stays `omnidirectional.app`, so existing passkeys keep working.
4. Mail DNS is unchanged: MX at Purelymail on the bare domain, system mail from
   `mail.omnidirectional.app` (ADR 0020). Those are mail records, not app hosts.

## Rollout (expand, then contract)

1. Add `omnidirectional.app` as a Worker custom domain next to `inbox.` and `api.`.
2. Add `https://omnidirectional.app/api/auth/callback/google` and
   `https://omnidirectional.app/api/connect/google/callback` to the Google OAuth client.
3. Point `BETTER_AUTH_URL` at `https://omnidirectional.app`, keep `https://inbox.omnidirectional.app`
   in `AUTH_TRUSTED_ORIGINS` while old tabs live, and point the mail service's `WORKER_URL` at the
   bare domain.
4. Once the bare domain answers and sign-in works there, drop `inbox.` and `api.` from
   `WORKER_DOMAIN` and `AUTH_TRUSTED_ORIGINS`, delete their custom domains, and remove the old
   Google redirect URIs.

## Consequences

- One origin for people, the iOS app (`EXPO_PUBLIC_OMNI_API_URL`), MCP clients and the mail
  service.
- Sessions are host-only cookies, so people signed in on `inbox.` sign in once more. MCP clients
  registered against the old issuer are added again.
- Links already sent to `inbox.` (invitations, magic links) stop working once step 4 lands;
  magic links last minutes and invitations days, so step 4 waits a few days.
- A marketing site later needs a path or a host that leaves the app's routes alone.
