# Mail service loose ends: duplicate send after crash, leftover app password, Sentry noise, fetch timeouts

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | low                                          |
| Area     | apps/mail                                    |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/mail/src/outbox.ts:57-60,254-255` (Sent lookup only when `delivered`)
- `apps/mail/src/hosting/rotate-login.ts:46-66` (revoke skipped if reconnect throws)
- `apps/mail/src/service.ts:216-227` (credentials_unreadable every 5 min)
- `apps/mail/src/objects.ts:122-146` (S3 calls without timeout)

## Problem

1. A crash between SMTP accept and `markSmtpAccepted` re-sends the message after the lease; the docstring promises a Sent check that only runs when `delivered`.
2. If reconnect throws during login rotation, the old Purelymail app password is never revoked.
3. A mailbox with unreadable credentials logs an error every reconcile (~288/day) and buries real Sentry issues.
4. R2 puts have no timeout; a hung put holds the mailbox's queue for ~5 min per attempt.

## Evidence

Read from the code.

## Fix

1. Also check Sent when `action.attempts > 1`.
2. Revoke the old password after a successful swap even if reconnect fails.
3. Remember failed `(id, credentialsEnc)` pairs and skip until the envelope changes.
4. Size-scaled `AbortSignal.timeout` on S3 calls.

## Done when

Mail e2e for 1 and 3 where practical.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
