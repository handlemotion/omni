# Notification preferences, undo-send and presence are built but have no UI

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Web settings + conversation                  |
| Who      | Needs Rodrigo: design                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/routes/library.ts:188-203` (GET/PATCH `/preferences`: per-kind realtime/desktop/push, theme, `undoSendSeconds`)
- `apps/web/src/components/settings/notification-pages.tsx` (local toggle only)
- `apps/web/src/components/settings/settings-pages.tsx:61-64` (search terms with no control)
- `apps/web/src/hooks/use-presence.ts` (imported nowhere)

## Problem

Notifications can't be tuned per kind and undo-send is stuck at 5 s. Collision detection (who else is viewing or replying, ADR 0021) is relayed by the Worker but never reported or shown, so two agents can answer the same customer.

## Evidence

No web callers.

## Fix

Per-kind toggles and an undo-send select backed by a preferences query/mutation. For presence: call `useReportPresence(thread, composerHasText ? "replying" : "viewing")` in `conversation.tsx` (2 lines) and design how to show it.

## Done when

Two signed-in members on one conversation see each other.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
