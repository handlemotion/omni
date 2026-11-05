# 0020: Auth and notice mail goes out through Cloudflare Email Sending

Date: 2026-11-05 · Status: accepted · Amends: ADR 0010 (how domain notices are sent)

## Context

Magic links, invitations, sign-in email confirmations and domain notices were written to the
outbox as a `send` from the mailbox at `SYSTEM_MAIL_FROM`, and the mail service delivered them
over SMTP. That needed a real, connected mailbox before anyone could sign in, so a new install (and
production) could not send a sign-in link until someone had set up a mailbox through a sign-in it
could not send. Production sign-in failed for exactly this reason: `SYSTEM_MAIL_FROM` was empty.

## Decision

- The Worker sends this mail itself, through a `send_email` binding (`EMAIL`) to Cloudflare Email
  Sending, from `SYSTEM_MAIL_FROM` under `APP_NAME`. No mailbox and no outbox row are involved.
- The address's domain is onboarded to Email Sending once, in the Cloudflare dashboard. It adds
  its own records under `cf-bounce.<domain>`, so the domain's existing mail setup stays as it is.
- Hosted Omni sends from `hello@mail.omnidirectional.app`. A sending subdomain keeps this mail's
  reputation and records apart from the apex domain's own mail (Purelymail).
- Tests read the messages from wrangler's local simulation of the binding (its local explorer
  API), so the e2e suites still check the real message and link without sending anything.

## Consequences

- A new install signs people in without a mailbox. It needs a Cloudflare account on the Workers
  Paid plan to send to any address (self-hosting already requires a Cloudflare account).
- This mail loses the outbox's retries and idempotency keys. A failed send fails the request
  (the person asks again); a retried request can send a notice twice. Both are rare and harmless.
- Members' own mail still goes through the outbox and their mailboxes, unchanged.
