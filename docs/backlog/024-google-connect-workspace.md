# Google connect uses the session's active workspace, not the tab's

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | low-medium                                   |
| Area     | Worker connect                               |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/routes/connect.ts:96,140`
- `apps/web/src/lib/google-connection.ts:22-27`

## Problem

The signed cookie stores only `memberId`, and the callback resolves the member from the session's active org. With two tabs in two workspaces, connecting from the other one fails as "expired" or lands the inbox in the wrong workspace (the workspace is in the URL, not the session).

## Evidence

Read from the code.

## Fix

Store `orgId` in the cookie; resolve with `findMember(db, user.id, flow.orgId, scopeOrgId)` and check `flow.memberId`; web passes `withWorkspace(url)`.

## Done when

Worker e2e in `connect.e2e.test.ts` with two workspaces.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
