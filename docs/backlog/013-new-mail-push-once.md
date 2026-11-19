# New-mail notifications and pushes are lost if anything fails after ingest

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Worker realtime                              |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `packages/db/src/mail/conversations.ts:577-600` (`workflowAppliedAt` committed in its own transaction)
- `apps/worker/src/routes/internal.ts:84-113`

## Problem

If anything after `applyInboundMessage` throws (Durable Object call, `newArrivals`, `fanOut`), the route returns 500 and the mail service retries. The retry sees `applied: false, fresh: false`, so no `customer_reply`/`assigned` notification, no New message push, and no `mail.arrived` for desktop watch sockets are ever sent for that mail. #493 removes the most likely trigger (an Expo failure).

## Evidence

Read from the code.

## Fix

Derive push and arrival targets from the event, not from `applied`/`fresh`, or record pending notifications in the same transaction and deliver them with retries (outbox pattern).

## Done when

Worker e2e: make the first delivery fail after ingest, retry, and assert the watch socket hears `mail.arrived` once.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
