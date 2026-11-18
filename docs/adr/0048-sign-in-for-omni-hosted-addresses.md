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

### Keeping an outside address (amended 2026-11-18)

5. **The last outside address stays.** Removing a sign-in email is refused (`409`) when it is the
   person's last verified address Omni does not host and they have other addresses: their hosted
   ones would have nowhere to send links.
6. **Omni never starts hosting someone's only address.** Making a new mailbox on Omni's mail host
   is refused (`409`) when its address is a verified sign-in address whose owner has no other
   address outside Omni. The owner adds one in Settings first (their session is unscoped in
   onboarding, before their domain is locked); for a teammate, the admin asks them to.
7. **An invitation goes to an address its invitee can read.** Inviting an address Omni hosts (its
   mailbox or its domain on Omni's mail host) is refused (`422`) unless it already belongs to
   someone whose links go elsewhere. The admin invites the email the person uses today and gives
   them the hosted inbox with the invitation (ADR 0026); onboarding's invite step shows the
   refusal.

Accounts already start safely: sign-up needs a confirmed address (a magic link opened, or Google's
`email_verified`), and nothing but "Make primary" changes the primary.

## Consequences

- People with a Gmail (or any outside address) in their cluster sign in with their hosted address
  again, from any device, with no new credential to store, reset or phish.
- Decisions 5 to 7 keep new accounts from ending up with only hosted addresses. Someone already
  in that state (hosted before this change) still needs another signed-in device; a recovery-only
  address addable from a scoped session would cover them and is not built.
- The per-address magic-link rate limit (ADR 0018) still counts the typed address, so a person's
  outside inbox can get up to that limit once for each hosted address they have.
- `apps/worker/e2e/session-scope.e2e.test.ts` proves the link reaches the outside address and the
  session it opens stays scoped to the company.
