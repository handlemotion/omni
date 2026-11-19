# CRM records can't be deleted, and domains and notes can't be removed or edited

|          |                                              |
| -------- | -------------------------------------------- |
| Severity | high                                         |
| Area     | Web CRM                                      |
| Who      | Needs Rodrigo: menu items and confirm dialog |
| Status   | open                                         |
| Found    | 2026-11-19, read against `main` at `15ffca9` |

## Files

- `apps/worker/src/crm/companies.ts:69,92`, `people.ts:78`, `deals.ts:73` (DELETE)
- PATCH `/crm/notes/:id`
- `apps/worker/src/crm/pipeline.ts:30-41` (GET/PUT `/crm/settings`, default currency)
- `apps/web/src/lib/crm-mutations.ts`

## Problem

A duplicate or wrong company, person or deal stays forever; a wrong domain stays attached and keeps matching mail; notes can't be edited; the default currency can't be changed.

## Evidence

None of these routes has a web caller.

## Fix

Delete mutations using `settle(crmChanged)` and `handlesError`; a Delete item in `RecordLayout`'s menu and on domain rows; edit for notes; a currency setting.

## Done when

Delete a company in the local stack: it disappears from lists and its domain stops matching new mail.

## Before you start

Read `AGENTS.md` (and the unit's own `AGENTS.md`), re-check the line numbers above against current
`main`, and set Status to `in progress` with your PR link in the same PR that fixes it. Delete this
file in the PR that closes the gap.
