# Worker loose ends: `action.succeeded` never sent, AI usage double-counted, upload cleanup unbounded

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | low                                          |
| Area     | apps/worker, packages/db                     |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `packages/contracts/src/index.ts:242-247` (`action.succeeded`, nothing emits it); `apps/web/src/lib/realtime.ts:280-296` (polls instead)
- `apps/worker/src/queue.ts:334` (`addAiUsage` before `saveTriage`)
- `apps/worker/src/uploads.ts:11` (`for(;;)`), `packages/db/src/mail/drafts.ts:63-73` (`cancelSend` re-arms shared uploads)

## Problem

Web polls `GET /api/actions/:id` for every send; a retried AI job adds its tokens twice (nothing reads `ai_usage` yet); the daily upload cleanup has no bound and deletes rows before objects; cancelling one send can make an upload another draft uses eligible for expiry.

## Evidence

Read from the code.

## Fix

Emit `action.succeeded` from the mail service via a new mail event (expand first); record usage in the same transaction as `saveTriage` or key it by message; cap the cleanup loop; only re-arm uploads no other pending send references. See also [draft-attachments-expire](004-draft-attachments-expire.md).

## Done when

Worker e2e per item.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
