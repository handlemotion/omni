# A draft's attachments are deleted after 24 hours, and the draft can no longer be sent

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | high                                         |
| Area     | Mail compose (packages/db, apps/worker)      |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/routes/compose.ts:43,485` (`UPLOAD_TTL_MS = 24h`)
- `packages/db/src/mail/drafts.ts:150-226` (`createDraft`, `saveDraft` store `{uploadId}`)
- `packages/db/src/mail/compose.ts:113-135` (`invalidSendAttachments` requires `expiresAt > now()` when unused), `:211-221` (`takeExpiredUploads`)
- `apps/worker/src/uploads.ts` (daily cleanup, `modules.ts:23`)

## Problem

Uploads attached to a saved draft are never pinned. After 24 h the daily cleanup deletes them; even before it runs, sending fails because `invalidSendAttachments` refuses an unused upload past `expiresAt`. Reopening the draft shows a 404 attachment; sending answers 400 "attachments not available to this mailbox". Shared drafts are hit hardest.

## Evidence

Verified by reading both the cleanup and the send check. Both need changing: fixing only the cleanup still leaves the send refused.

## Fix

Pick one and record it in the PR:

- (a) Treat an upload referenced by a draft in the same mailbox as live: add `not exists (select 1 from drafts d where d.mailbox_id = uploads.mailbox_id and d.attachments @> jsonb_build_array(jsonb_build_object('uploadId', uploads.id)))` to `takeExpiredUploads`, and accept such uploads in `invalidSendAttachments`.
- (b) Extend `expiresAt` of referenced uploads whenever a draft is created or saved (e.g. 30 days).
  Deleting a draft lets its uploads expire normally.

## Done when

New case in `apps/worker/e2e/drafts.e2e.test.ts`: save a draft with an upload, age the upload past `expiresAt`, run the cleanup, then send the draft: it sends with the attachment.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
