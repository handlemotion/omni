# The per-kind push setting does nothing; mentions and assignments never push; dead tokens aren't pruned

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | Worker realtime                              |
| Who      | Agent (+ Rodrigo for the settings UI)        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/realtime.ts:296-366` (`notifyMembers` checks only `realtime`)
- `packages/db/src/notifications.ts:61` (`membersAccepting(..., "push")` never called)

## Problem

Mentions, assignments and SLA alerts are never pushed to phones. The New message push goes to every offline member without checking preferences. Expo `DeviceNotRegistered` errors never remove stale tokens.

## Evidence

Read from the code.

## Fix

Add a push step to `notifyMembers` gated by the `push` preference; gate the new-mail push the same way (or add a kind for it); read Expo's per-ticket errors and delete unregistered tokens.

## Done when

Worker e2e with `EXPO_PUSH_ENABLED` and a recorded Expo response (no mocks: use a local HTTP endpoint via config).

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
