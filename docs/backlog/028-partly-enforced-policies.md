# Partly enforced policies

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | low                                          |
| Area     | Docs + scripts                               |
| Who      | Agent                                        |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `scripts/check-tests.mjs:29-33`, `scripts/check-modules.mjs:276-283`

## Problem

The e2e no-mocks check misses hand-written stub servers (e.g. the TypeSafe 503 stub in `ai-queue-failures.e2e.test.ts:23-37`). `apps/worker/src/mail/` can import mail tables and skip `forMember` without failing a check (no file does today).

## Evidence

Read from the scripts.

## Fix

Have `check-modules` forbid mail-table imports in `apps/worker/src/mail/**` except via `forMember` helpers. Decide whether stub servers are allowed and say so in AGENTS.md (needs Rodrigo).

## Done when

Unit tests for the scripts in `scripts/`.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
