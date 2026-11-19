# One message with an oversized Message-ID can stall a folder's import and stop pruning

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | high                                         |
| Area     | Mail sync (apps/mail, mail-core)             |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `packages/mail-core/src/parse.ts:365-376` (`MESSAGE_ID` regex, no length cap)
- `apps/mail/src/mailbox-connection.ts:293-313,643,710,749-766`
- `packages/db/src/schema/mail/messages.ts:260-264` (unique and GIN indexes)

## Problem

Message-ID, In-Reply-To and References values are stored uncapped. An id over ~2.7 KB exceeds Postgres's btree index row limit on `unique(mailbox_id, message_id_header)` and `in_reply_to`, so the insert fails every time. The storer rethrows after 5 consecutive failures; UIDs import newest first, so five such messages at the top of a folder stop its history import. A single one sets `clean = false` on every sync, so pruning of deleted mail and `reportDiscarded` never run for that mailbox, and `uidNext` never advances.

## Evidence

Not reproduced; derived from reading the code. Nothing tracks or skips a message that fails every time.

## Fix

1. In `parse.ts`, replace any id longer than ~250 characters with a hash in the existing `<…@omni.invalid>` form, and drop overlong References entries (small).
2. Add `fixtures/eml/oversized-message-id.eml` and a case in the pipeline unit test.
3. Later: count failures per (folder, uid) and skip-and-log a message after N attempts so it stops counting against `clean`.

## Done when

The new fixture parses to a bounded id; the mail e2e sync of a folder containing it completes and prunes.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
