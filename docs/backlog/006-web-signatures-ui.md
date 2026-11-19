# Inbox signatures can be read but not set or removed

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | high                                         |
| Area     | Web settings                                 |
| Who      | Needs Rodrigo: settings row design           |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/routes/library.ts:74` (PUT), `:91` (DELETE) `/mailboxes/:mailboxId/signature`
- `apps/web/src/lib/compose.ts:82-90`, `components/compose/composer.tsx:44` (read only)

## Problem

The composer inserts a signature nobody can create or change in the product.

## Evidence

No web caller for PUT or DELETE.

## Fix

A signature row in the inbox settings (inbox and personal scope, as the API supports), with a mutation that invalidates `keys.signatures(mailboxId)`.

## Done when

Set, change and clear a signature; a new reply shows it.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
