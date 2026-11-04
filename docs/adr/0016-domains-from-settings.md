# 0016: More than one domain per workspace, managed from settings

Date: 2026-11-04 · Status: accepted · Amends: ADR 0010 (release)

## Context

Onboarding (ADR 0007, 0010) adds a workspace's first domain. The plan is one flat price per
workspace with unlimited domains (ADR 0015), so a workspace needs to add more later, and to remove
one it added by mistake or no longer uses. The settings General page already lists the domains
with their status and DNS records.

## Decisions

### Adding reuses onboarding's claim, unchanged

Settings calls the same `POST /api/onboarding/domains` and `POST /api/onboarding/domains/:id/check`
as onboarding: owners and admins, the per-claim `_omni-challenge` TXT, the provider's records from
the mail service, the lock on first verify, the 5-pending cap and the rate limits. No new route,
no new mail-service call. Setup only moves forward (`advanceOrgSetup` takes the furthest step), so
a finished workspace adding a domain stays finished.

A domain belongs to one workspace at a time: the existing lock (`mail_domains`, unique on the
domain, and refusing a name under another workspace's domain). Each domain keeps its own claim,
records and last check.

There is no default domain. A mailbox is created on a domain chosen by id, and a reply is sent
from the mailbox it came to, so nothing needs one yet.

### Removing: withdraw a claim, or release a lock

`POST /api/onboarding/domains/:id/release` now covers both cases:

- **A claim that never verified** (pending or expired): any owner or admin withdraws it. The
  claim becomes `released`, leaves the list and the pending cap, and its value stops counting;
  adding the domain again opens a new claim with a new value. Audited as `domain.claim_withdrawn`.
  No mailbox can exist without a lock, so nothing else changes and no one is emailed.
- **A verified domain**: as ADR 0010, owners only, refused while the workspace has mailboxes on
  it (`409`), and every owner is emailed.

Removing never deletes mail rows and never calls the mail host. On the Purelymail path the domain
stays on Omni's Purelymail account; another workspace that later claims and verifies it finds it
there already. Removing a domain's mailboxes first is a separate, deliberate step that does not
exist yet.

## Consequences

- An admin can now undo a claim they made; giving up a verified domain still needs an owner.
- A claim withdrawn while its check is running cannot lock: the lock's update requires a
  `pending` claim, so the check rolls back. A claim that verified first is not withdrawn (`409`).
