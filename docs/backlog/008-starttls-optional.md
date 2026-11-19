# IMAP/SMTP use STARTTLS only if offered, so a downgrade exposes mailbox passwords

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium-high                                  |
| Area     | Security (apps/mail, apps/worker)            |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/mail/src/mailbox-connection.ts:465-477`
- `apps/mail/src/outbox.ts:378-386`
- `apps/mail/src/verify-login.ts:158-166`
- `apps/worker/src/provision-mailbox.ts:37-41`

## Problem

`secure` is true only for ports 993 and 465. On 143/587, ImapFlow is created without `doSTARTTLS: true` and Nodemailer without `requireTLS: true`, so they fall back to plaintext if the server's STARTTLS offer is stripped. An on-path attacker could capture IMAP/SMTP passwords at verify time and on every reconnect.

## Evidence

Read from the connection options; not exploited.

## Fix

Require STARTTLS whenever `!secure` (`doSTARTTLS: true`, `requireTLS: true`). Allow plaintext only for hosts listed in a new env var (e.g. `MAIL_ALLOW_PLAINTEXT_HOSTS`) so GreenMail and dev-seed keep working; document it in `apps/mail/.env.example` and `docs/self-hosting.md`.

## Done when

Mail e2e against GreenMail passes with the allowlist set; a unit or e2e case shows a host not on the list is refused without STARTTLS.

## Notes

Security fix: keep reproduction details out of the public PR.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
