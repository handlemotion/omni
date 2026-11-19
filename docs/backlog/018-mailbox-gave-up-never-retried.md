# A mailbox connection that gives up stays dead until the next deploy

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Mail supervisor (apps/mail)                  |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/mail/src/mailbox-connection.ts:396-405` (emits `gave_up`)
- `apps/mail/src/service.ts:211-213,246-250`
- `apps/mail/src/supervisor.ts:94-112`

## Problem

Nothing listens for `gave_up`. The dead connection stays in `supervisor.connections`, and `reconcileOnce` skips ids it already has. An auth outage longer than ~15 minutes leaves the mailbox silently stopped (status `error`).

## Evidence

Read from the code.

## Fix

On `gave_up`, schedule `supervisor.remove(id)` after a cooldown (e.g. 1 h) so the next reconcile rebuilds it from stored credentials.

## Done when

Mail e2e: break the GreenMail password, wait for give-up, fix it, and the mailbox resumes within the cooldown (use a short cooldown via config in the test).

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
