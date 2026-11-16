# 0042: A Personal space may own its person's domain

Date: 2026-11-16 · Status: accepted · Amends: ADR 0024 decision 1 ("refuses domain claims")

## Context

ADR 0024 gave every person a Personal space for the mail they bring themselves (a personal Gmail),
and kept domains for companies. People also own personal domains (`me@myname.dev`) that are not a
company's, and want that mail in Omni beside their Gmail, hosted by Omni rather than kept
elsewhere. Today they would have to create a company with one member to do it, and adding a domain
from a Personal space's settings answered 500 (`PersonalSpaceError`).

## Decision

1. **A Personal space can claim and lock a domain**, by the same claim, challenge and checks as a
   company (ADR 0010, 0016): Settings, General, Domains. One workspace still owns a domain at a
   time, so a company cannot claim a domain a Personal space holds until it is released or moved
   to that company (moving into a Personal space stays refused).
2. **Every mailbox on it is its owner's personal inbox.** A Personal space has one member, so the
   setup route (`POST /api/onboarding/mailboxes`) makes any address there `personal`, not only the
   sign-in address. Shared mailboxes stay refused.
3. **A Personal-space lock is not a company claim.** Sign-in scoping (decision 3 of ADR 0024) and
   mailbox placement (decision 2) look only at company locks, so signing in with an address on a
   personal domain stays unscoped, and the lock moves no one's mailboxes.
4. **Settings is the whole flow:** Add a domain, its records, then "Create your inbox" in the same
   dialog once the domain takes mailboxes; Inboxes offers more addresses later.
   `GET /api/onboarding` lists a Personal space's domains and mailboxes, with `organization` still
   null, so company setup is unchanged.

## Consequences

- A personal domain on Omni's mail host is free, like the rest of a Personal space (ADR 0024).
  Hosted mailboxes cost the hosting account a little each; if that is abused, a per-space cap goes
  on the setup route.
- Mail already at the domain's old host stays there; Omni receives what arrives once its MX
  records are in. Importing old mail is not part of this.
