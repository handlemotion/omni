# Spam and Trash are dead ends in the web app

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | high                                         |
| Area     | Web (apps/web) mail                          |
| Who      | Needs Rodrigo: menu labels and placement     |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/routes/folders.ts` (`/threads/:id/spam`, `/not-spam`: no web caller)
- `apps/web/src/hooks/use-mail-actions.ts:43-60` (`useArchive`, `useMove` unused)
- `apps/web/src/components/inbox/row-menu.tsx`
- `apps/web/src/components/conversation/conversation.tsx:346-349`

## Problem

Mail that lands in Spam can't be marked Not spam, spam can't be reported, and a trashed thread can't be restored to the Inbox from Omni. The backend routes exist.

## Evidence

Searched `apps/web/src` for each route's RPC accessor: none.

## Fix

Add Not spam / Report spam to the row menu, conversation actions and shortcuts (mutations built like `trashMutation`, with `removeFromLists`). Use `useMove` for Move to Inbox from Trash. Read `DESIGN.md` first; no new helper copy.

## Done when

In the local stack: a thread in Spam moves back to Inbox, and a trashed thread restores; the IMAP folder changes in GreenMail.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
