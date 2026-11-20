# CRM features have a backend but no UI

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium-high                                  |
| Area     | Web mail + CRM                               |
| Who      | Needs Rodrigo: design                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/mail/save-to-drive.ts:20-21` (Save to drive)
- `apps/worker/src/crm/find.ts:16` (`GET /crm/lookup`)
- `apps/worker/src/mail/crm-sharing.ts:29-32` (mail activity sharing)
- `apps/web/src/components/conversation/attachments.tsx:35`

## Problem

Save an attachment to Drive, CRM participants in the conversation sidebar, and per-mailbox CRM activity sharing are built and tested in the Worker but unreachable.

## Evidence

No web callers.

## Fix

Attachment menu item with the Storage folder picker; a participants block in the conversation sidebar with add-sender; a mailbox setting off/activity/subjects.

## Done when

Each feature exercised in the local stack.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
