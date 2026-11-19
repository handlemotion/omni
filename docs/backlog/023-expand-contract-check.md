# No check stops a PR from reading a column its own migration adds

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | low-medium                                   |
| Area     | Policy scripts                               |
| Who      | Agent (root config: propose first)           |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `scripts/check-*.mjs`
- Example: #486 added `mailboxes.label`/`picture` in `0048_outstanding_stick.sql` and read them in the same PR

## Problem

AGENTS.md requires expand, then contract. #486 broke it and production threw 55 errors (OMNI-WORKER-F) while the migration waited for a runner. #489/#491 later split it correctly.

## Evidence

See [production-runner-lag](001-production-runner-lag.md).

## Fix

A `scripts/check-expand-contract.mjs` that fails when a diff adds a migration column and non-schema code in the same diff references it (compare `git diff main...HEAD`). Wire into `pnpm check` with a unit test in `scripts/`.

## Done when

The script fails on a replay of #486's diff and passes on #489.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
