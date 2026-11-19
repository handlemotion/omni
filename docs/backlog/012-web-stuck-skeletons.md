# Dialogs, settings and notifications show a skeleton forever, or a false empty state, when a fetch fails

|          |                                                 |
| -------- | ----------------------------------------------- |
| Severity | medium                                          |
| Area     | Web (error states, ADR 0046)                    |
| Who      | Agent (UI owned by Rodrigo; no new copy needed) |
| Status   | open                                            |
| Found    | 2026-11-19, read against `main` at `15ffca9`    |

## Files

- `apps/web/src/components/storage/comments-panel.tsx:130-140`, `versions-dialog.tsx:64-67`, `share-dialog.tsx:53-56`, `signatures-dialog.tsx:51-55`, `storage-usage.tsx:23`
- `components/settings/workspace-pages.tsx`, `helpdesk-pages.tsx`, `ai-page.tsx`, `account-pages.tsx`, `forwarding-page.tsx`, `mailbox-pages.tsx`
- `components/shell/notifications.tsx:252-271` (shows "No notifications" on error)
- `components/settings/pipeline-page.tsx:41,75` (empty stages on error; Save replaces the whole pipeline)

## Problem

`<Skeleton data={q.data}>` with no `isError` branch. The query client sets no `throwOnError`, and ADR 0046 stops retrying 404s and refusals, so a failed request stays loading forever. The pipeline page is the worst: an owner sees no stages and can overwrite the real pipeline.

## Evidence

None of these files reads `isError`.

## Fix

Before each Skeleton: `q.isError ? <ListFailed retry={() => void q.refetch()} /> : …` (`ListFailed` lives in `components/inbox/thread-list.tsx:119`; move it to a shared spot). In the pipeline page also disable add/edit until stages load. Do notifications and pipeline first.

## Done when

Block the route in the browser (devtools) and confirm each surface shows Try again and recovers.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
