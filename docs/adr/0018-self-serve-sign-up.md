# 0018: Self-serve sign-up

Date: 2026-11-04 · Status: accepted · Amends: spec v1 "Non-goals" (self-serve signup), ADR 0007
(workspace creation policy)

## Context

Until now sign-up was by invitation only. The `user.create` hook refused any new user without a
pending invitation (`SIGN_UP_REQUIRES_INVITATION`), a magic-link request for an unknown address
was answered `200` and mailed nothing, and the first owner of an install came only from the
`org:create` CLI. `ORGANIZATION_CREATION` (`owners` or `anyone`) decided who could create a
workspace in onboarding, but could not let anyone in. So nobody could try Omni without knowing us.

Billing (ADR 0015) is in place: every new workspace starts on a trial during setup, and an unpaid
workspace is read-only with no AI. Domain claims need Omni's own TXT proof (ADR 0010). That is
what made invitation-only necessary, and it now holds on its own.

## Decision

**Anyone with a verified email may sign up.** A magic link proves the address; Google must say
`email_verified`. A new user has no workspace; the route guards send them to `/onboarding`, which
creates one (name, domain, mailboxes, plan, invitations; ADR 0007, 0009, 0015). Its creator is its
owner.

**`SIGN_UP` replaces `ORGANIZATION_CREATION`.**

- `open` (default): every address gets a magic link; any verified address becomes a user; anyone
  signed in may create a workspace.
- `invitation`: the old behaviour, for private installs. Sign-up needs a pending, unexpired
  invitation, a magic-link request for an unknown address is answered alike but mailed nothing,
  and only people who already own a workspace create another.

The default is `open` because hosted Omni is the product. A self-hoster with no billing who leaves
it open lets anyone who reaches the install use their AI key; `docs/self-hosting.md` says so and
points to `invitation`.

**What stays guarded, unchanged:**

- Only a verified address becomes an identity (`EMAIL_NOT_VERIFIED`).
- An address that already signs in to someone (ADR 0014) never becomes a second person
  (`EMAIL_BELONGS_TO_ANOTHER_USER`), and Google links only to a verified local address.
- Invitations still join existing workspaces; nobody joins a workspace any other way.
- Rate limits (Worker, per `RATE_LIMIT_*`): magic links per address (`5/900`), so nobody can
  mail-bomb an inbox from our system mailbox; sign-in steps per IP (`60/60`); mailbox creation
  per member; invitations per inviting user.
- A domain is claimed only with Omni's TXT challenge (ADR 0010), so a stranger cannot create
  mailboxes on someone else's domain through the provider API.
- Billing (ADR 0015): setup finishes and invitations go out only with a trial or a plan in good
  standing, and an unpaid workspace is read-only with no AI. One trial per workspace.

## Consequences

- A new address that requests a link now gets one, so the endpoint no longer hides whether a
  random address could sign in. It still does not say whether the address has an account.
- One person can create several workspaces, each with its own trial. What a trial spends is
  bounded per workspace: triage by the monthly allowance (`BILLING_TRIAGE_ALLOWANCE`), summaries
  by the daily token cap (`AI_DAILY_TOKEN_CAP`), on mail from domains they proved. There is no
  per-person limit on workspaces or trials; revisit if trials are farmed.
- An address someone asked to add as a sign-in email (ADR 0014) but has not confirmed is not
  theirs yet: whoever proves it first owns it. A sign-up with it makes a new person, and the
  asker's confirmation link then answers `409` (`sign-in-emails.e2e.test.ts`).
- A user who signs up and never creates a workspace is a row in `users` with no membership. They
  are harmless and not cleaned up.
- An install that set `ORGANIZATION_CREATION` should set `SIGN_UP` instead; the old variable is
  ignored.
