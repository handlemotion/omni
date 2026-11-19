# Sends and archives wait behind a whole folder import, and stall the outbox for every mailbox

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium-high                                  |
| Area     | Mail outbox (apps/mail)                      |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/mail/src/mailbox-connection.ts:293-295,332-349,527-537`
- `apps/mail/src/outbox.ts:97-107`

## Problem

After INBOX syncs, `ready` is set and each other folder is enqueued as one task in the same queue `run()` uses. `run()` fails fast only when not ready, so an outbox action waits behind e.g. a large All Mail import. `drain()` waits for the whole batch before claiming more, so every other mailbox's actions wait too. This contradicts `run()`'s docstring ("never waits behind a long import").

## Evidence

Read from the code; not timed.

## Fix

Give `run()` a start deadline (~15 s): if the task has not started by then, mark it abandoned (the task checks first) and reject with `MailboxUnavailableError`; `defer` already returns the attempt to the queue.

## Done when

A mail e2e case: with a large folder importing, a send on that mailbox is deferred, and a send on another mailbox completes promptly.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
