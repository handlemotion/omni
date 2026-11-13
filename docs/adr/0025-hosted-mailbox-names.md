# 0025: Hosted mailbox names: symbolic subaddressing off on domains Omni adds

Date: 2026-11-13 · Status: accepted · Amends: ADR 0007 (Purelymail domains and mailboxes)

## Context

Purelymail turns symbolic subaddressing on for every new domain. With it on, everything after a
symbol in an address is a tag (`hello+news@` and `hello-news@` reach `hello@`), dots are ignored
(`first.last@` reaches `firstlast@`), and Purelymail refuses to create a user whose name contains
`.`, `-`, `_` or `+` (`invalidUserName`, checked live on 2026-11-13). Onboarding accepts names like
`first.last` and `support-team`, so creating them failed with a 502 and Purelymail's message.

## Decision

- When Omni adds a domain to Purelymail, it turns symbolic subaddressing off right after
  `addDomain` (`updateDomainSettings`). Names with `.`, `-` and `_` then work as their own mailboxes.
- Domains already on the account keep their setting. On a domain with it on, Omni refuses a name
  with a symbol before calling Purelymail, with a 422 that says to use letters and digits only.
- Omni never changes the setting on a domain it did not add. omnidirectional.app keeps it on.

## Consequences

- **Tag aliases stop on new domains.** Mail to `hello+news@` or `hello-news@` no longer reaches
  `hello@`; it bounces unless a mailbox or routing rule has that exact name. A helpdesk rarely
  relies on tags, and a real alias is clearer when one is needed.
- **Dots count on new domains.** `first.last@` and `firstlast@` are two different mailboxes, as in
  Outlook. Gmail ignores dots, so a sender who drops the dot gets a bounce instead of the person.
- **Old and new domains differ.** A domain added before this change (or one whose settings call
  failed after `addDomain`) still reads symbols as tags and refuses symbol names with a reason.
  Its setting can be switched later in Purelymail, which changes where its tagged mail goes.
- The live e2e (`apps/mail/e2e/purelymail-live.e2e.test.ts`) keeps its test domain with the
  setting on, so it exercises the refusal path; the settings call itself was verified live.
