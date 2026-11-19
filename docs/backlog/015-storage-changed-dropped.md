# `storage.changed` realtime events are dropped by `@omni/client`, so Drive doesn't refresh live

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | medium                                       |
| Area     | packages/client, Worker realtime             |
| Who      | Agent (+ Rodrigo for the web handler)        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/realtime.ts:119-133`
- `packages/client/src/realtime.ts:273,335-339`
- `apps/web/src/lib/realtime.ts:107-140`

## Problem

The Worker broadcasts `{type: "storage.changed", space}`, but `parseStorageEvent` returns undefined without a `nodeId` and nothing else matches. Web Drive views don't refresh when a teammate uploads, restores or unlocks a file. For shared drives the event also reaches `watch:` sockets, which should only get watched events.

## Evidence

Read from the code. Only the desktop sync path uses this event today.

## Fix

Parse `storage.changed` with `storageChangedEventSchema` and add it to the `RealtimeEvent` union; skip `watch:` tags in `storageChanged`; in web, invalidate `keys.storage()` on it.

## Done when

Worker e2e: a teammate's upload reaches another member's app socket as `storage.changed` and not their watch socket.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
