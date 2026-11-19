# Orphan routes and dead web code

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | low                                          |
| Area     | Web + Worker                                 |
| Who      | Agent (deletions in web: ask Rodrigo)        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- Routes with no client: `GET /mailboxes/:id/report`, `GET /workspace/events`, `POST /api/onboarding/domains/:id/transfer`, POST/DELETE `/threads/:id/defer`
- Web: `components/google/connect-google.tsx`, `hooks/use-presence.ts`, `useArchive`/`useMove`, `components/settings/kit/settings-{button,collapsible,textarea,file}-row.tsx`
- `components/ui/multiple-select.tsx` (icon button with no `aria-label`, inline SVG)
- `components/storage/preview/pdf-marks.tsx:202` (area comments need a pointer)

## Problem

Built routes nobody calls, and components nothing imports. Area comments on PDFs can't be placed from the keyboard.

## Evidence

Searched for imports and RPC accessors.

## Fix

Decide per route: build the UI or remove it (expand/contract: remove only once no client calls it). Delete `connect-google.tsx` and the unused settings-kit rows. Add a keyboard path for area comments.

## Done when

`pnpm check` and `pnpm check-types` pass after deletions.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
