# 0048: Sign-in links for addresses Omni hosts go to an outside address

Date: 2026-11-18 · Status: accepted · Amends: ADR 0014 (sign-in emails), ADR 0018 (magic links)

## Context

Omni signs people in with a magic link, a passkey, or Google (spec v1 "Security", ADR 0014). A
magic link is mailed to the address typed on the sign-in screen.

Once Omni hosts that address (a mailbox on Omni's mail host, provider `purelymail`; ADR 0007,
0042), the link lands in the mailbox it is meant to unlock. The person can read it only if they
are already signed in on another device. Passkeys do not fill the gap on their own: the first
session still needs a link, and a session opened with a company's address cannot add a passkey
(ADR 0024).

Most people already have an outside address on their identity (ADR 0014): the Gmail they signed
up with, or a verified extra sign-in email.

## Decision

1. **A magic link for an address Omni hosts goes to the person's first outside address.** When
   the typed address is a verified sign-in address of a user and has a `purelymail` mailbox, the
   link is mailed to that user's first verified sign-in address (primary first, then extras in
   the order added) that Omni does not host. With none, it goes to the typed address, as before.
   Addresses on other providers (Gmail, Microsoft, IMAP) have their own webmail and are mailed
   directly.
2. **The link still signs in as the typed address.** Its token names the typed address, so the
   session is scoped exactly as before (ADR 0024): a company's address opens only that company,
   wherever its link was read. Receiving the link does not make the outside address the key.
3. **The mail says which address it signs in.** "Sign in to Omni as ana@acme.com", so a link read
   in a personal inbox is not mistaken for that inbox's own sign-in.
4. **The sign-in endpoint answers alike either way.** It never says where the link went, so it
   does not reveal a person's outside address or whether the typed one is hosted.

## Consequences

- People with a Gmail (or any outside address) in their cluster sign in with their hosted address
  again, from any device, with no new credential to store, reset or phish.
- A person whose only address is one Omni hosts is still stuck until they are signed in on another
  device. The follow-up, not built here: a scoped session may add a recovery-only address (it
  receives links for the hosted address, never signs in by itself, so it cannot widen the scope
  ADR 0024 guards), and an invitation to a hosted address can be sent to a personal one.
- The per-address magic-link rate limit (ADR 0018) still counts the typed address, so a person's
  outside inbox can get up to that limit once for each hosted address they have.
- `apps/worker/e2e/session-scope.e2e.test.ts` proves the link reaches the outside address and the
  session it opens stays scoped to the company.
