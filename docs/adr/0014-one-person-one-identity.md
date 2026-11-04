# 0014: One person, one identity; any verified email signs in

Date: 2026-11-04 · Status: accepted · Amends: spec v1 "Security" (sign-in), "Data model"

## Context

A person reaches every mailbox from one identity. They sign in with their own address (often a
personal Gmail), not with an Omni mailbox: losing a mailbox must never lock anyone out, and a
person must not depend on an Omni address to get in. They may want more than one address (a
personal Gmail and a work address), and Google and magic links should both work.

What Better Auth 1.7 did before this change (read from its source and docs):

- **Account linking was on by default, but implicitly.** A Google sign-in links to the user with
  the same email only when Google's `email_verified` is true _and_ the local user's
  `emailVerified` is true (`requireLocalEmailVerified`, default true). A magic link to the address
  of a Google-created user finds that user. So magic link → Google and Google → magic link already
  resolved to one user for addresses that had been proven, and the config said none of it.
- **An `org:create` owner who never opened a magic link is unverified,** so Google could not link
  to them. That is correct (the row has not proven the address), and stays.
- **A user has exactly one email.** Better Auth has no secondary-email feature (only
  `changeEmail`), and every lookup — magic-link verify, the OAuth callback, invitations — matches
  `users.email` only. Organization invitations can be seen, accepted or declined only when the
  invitation's address equals the session's `users.email`.

## Decision

1. **A person is a Better Auth user.** Mailboxes are reached through that user's `members` rows
   (one per organization) and `mailbox_access`, as before. Nothing about mail access is keyed on
   an email address.
2. **Account linking is explicit:** `enabled`, `requireLocalEmailVerified`,
   `allowDifferentEmails: false`, and `trustedProviders: []`. In Better Auth a _trusted_ provider
   links even when it says the address is unverified; we trust none past its own
   `email_verified`. Google is our only social provider, and it links only on an address both
   sides have verified. Sign-up also refuses any user whose address is not verified
   (`EMAIL_NOT_VERIFIED`), so an unverified Google address can neither link nor create a user.
3. **Extra sign-in emails live in `user_emails`** (`user_id`, `email`, `verified_at`), unique on
   `lower(email)`. The primary stays `users.email`. Only verified addresses get a row; a pending
   one is a hashed, single-use token in Better Auth's `verifications` table that expires in an
   hour. An address belongs to at most one person, primary or extra: adding one that another user
   has (verified or not) is refused, and verification takes an advisory lock on the address and
   rechecks before inserting.
4. **Any verified address finds its person.** The Drizzle adapter Better Auth uses is wrapped
   (`resolveSignInEmails` in `@omni/auth`): a `user` lookup by email that finds nothing falls
   back to `user_emails`, inside transactions too. That one seam covers magic-link verify, the
   Google callback, sign-up checks and "already a member" on invite. `maySignIn` (who gets a magic
   link mailed) counts extra addresses too.
5. **Invitations to an extra address join the existing user.** Before Better Auth's
   `get-invitation`, `accept-invitation` and `reject-invitation`, a pending invitation addressed
   to one of the signed-in user's verified extra emails is readdressed to their primary. Only the
   address's verified owner triggers it.
6. **Managing addresses** is `/api/account/emails` on the Worker: list; add (mails a link to
   `<WEB_APP_URL>/settings/emails/verify?token=…`; answered alike whether or not the address is
   someone else's, so it reveals no accounts); verify (a POST from that page, by the user who
   asked for it — another user's session gets 403 and does not spend the token, and a mail
   scanner that opens the link spends nothing); make primary (the old primary becomes an extra
   address if it was verified); remove (never the primary, never the last verified address).
   Adding counts against the per-address magic-link limit, since it mails the address.

## Not multi-session

Multi-session (Better Auth's plugin: several accounts signed in on one browser, switched with
`setActive`) is for _separate identities_ — say, a personal Omni and a client's Omni deployment
account. Sign-in emails are the opposite: several addresses, one identity, one set of
memberships. The two are independent and multi-session is unchanged.

## Departures

- **`user_emails` has no `org_id`.** It is per person, like `users`, `accounts` and `passkeys`.
- **The adapter wrapper depends on Better Auth looking users up through `findOne` with a single
  `email` clause** (true across 1.7's routes and plugins). An upgrade that changes that shape would
  silently stop resolving extra addresses; `apps/worker/e2e/sign-in-emails.e2e.test.ts` fails if
  it does.

## What is not exercised live

The Google code exchange needs Google. The e2e drives Better Auth's own OAuth sign-in step
(`handleOAuthUserInfo`, what the callback runs once Google answers) against the real database with
the profile a Google ID token carries; the Worker's start-and-cancel round trip is covered in
`google-sign-in.e2e.test.ts`. Everything else (magic links from the real outbox, invitations, the
Worker routes, the web pages) runs end to end.
