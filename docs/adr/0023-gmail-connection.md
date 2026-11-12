# 0023: Personal Gmail through a Google connection

Date: 2026-11-12 · Status: accepted · Amends: spec v1 "Out of scope" (Gmail), "Later" (EmailEngine)

## Context

Omni is becoming a shared-inbox helpdesk (ADR 0021). People still want their own mail next to the
team's, and most of it lives in Gmail. Rodrigo's decision: personal mail comes through a Google
connection, with Gmail as the source of truth, so Omni is a 1:1 client for that account.

Gmail offers two ways in: the Gmail REST API, or IMAP and SMTP with OAuth (XOAUTH2). Both need the
same restricted scope for full mail access (`https://mail.google.com/` for IMAP/SMTP), so both need
Google's verification and a CASA security assessment before more than 100 people can connect.
The spec once planned EmailEngine for this; its license costs more than the rest of the stack.

## Decision

1. **IMAP and SMTP with XOAUTH2, in `apps/mail`.** The mail service already syncs, IDLEs and sends
   over IMAP/SMTP (ADR 0013); a Gmail mailbox is one more `MailboxConnection` that logs in with an
   access token instead of a password. No Gmail API client, no second sync engine.
2. **The Worker never holds a Gmail token.** The Worker runs the OAuth redirect (it owns the web
   origin and the session) and forwards the authorization code, HMAC-signed, to the mail service's
   `POST /google/connect` (`@omni/contracts`). The mail service exchanges it, keeps the refresh
   token encrypted in `mailboxes.credentials_enc` with `MAIL_CREDENTIALS_KEY` (the same envelope as
   app passwords, now a union of password and Google logins) and mints access tokens itself. The
   Worker's request asks for `openid email https://mail.google.com/` with `access_type=offline` and
   `prompt=consent`, and should use PKCE; the mail service refuses a grant without the Gmail scope,
   without a refresh token, or for an address Google has not verified.
3. **A Google account is a personal mailbox, provider `gmail`.** It needs no domain claim: Google
   vouched for the address, and only its owner could consent. Connecting the same account again
   replaces its tokens; an address that is already a non-Gmail mailbox in the workspace is refused.
4. **Tokens.** Access tokens live in memory, refreshed when less than five minutes remain, one
   refresh shared by every caller. The token from the code exchange is stored with the refresh
   token, so the first connect needs no refresh. A rejected login or SMTP `EAUTH` drops the cached
   token, so the retry mints a new one. Google answering `invalid_grant` (access revoked in the
   Google account, or the grant expired) is a rejected login: the mailbox goes to `error`, retries
   stop after `maxAuthFailures`, and a send fails for good with "reconnect it". Connecting again
   repairs it.
5. **Configuration.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the mail service, both or
   neither. The Worker's sign-in client (ADR 0014) can be reused; its consent screen must list the
   Gmail scope. Without them a Google mailbox shows `error` and the connect route answers 404.
6. **Gmail's folders** (layer G2). Gmail is detected by its `X-GM-EXT-1` capability, so a Gmail
   account behaves the same however it logs in. Only system folders sync, mapped by special-use
   flag: INBOX, `\Sent`, `\Drafts`, `\Junk` (Spam), `\Trash`, and `\All` (All Mail) as the archive.
   Label folders, `\Important` and `\Flagged` (Starred) are skipped: their messages are all in All
   Mail, and syncing them would only add copies. Archive moves INBOX to All Mail, which in Gmail
   removes the Inbox label. Gmail files SMTP submissions in Sent itself, so Omni does not append a
   second copy. Threads follow Gmail's `X-GM-THRID`, so a conversation in Omni is the conversation
   in Gmail; the subject and References heuristics apply only to mail that has no Gmail thread id.

## Consequences

- One code path for every provider; Gmail differences are a capability check and a credential
  kind. Purelymail and plain IMAP behave exactly as before.
- All Mail holds every message, so a large Gmail account's first sync is long; INBOX comes first
  (A7) and the rest follows in the background.
- Gmail labels other than the system folders are not shown in v1.
- Until Google verifies the app, at most 100 people (listed as test users) can connect. Public
  launch needs verification and CASA (plan item G5, Rodrigo's).
- GreenMail speaks XOAUTH2 but is not Gmail. The local e2e proves XOAUTH2 on IMAP and SMTP with a
  stored token; refresh, revocation and Gmail's folders are proven only by
  `apps/mail/e2e/google-live.e2e.test.ts`, which runs on request against a dedicated test account.
