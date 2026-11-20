# 0054: CRM records parity: sort, filter, owners, close dates, restore and bulk actions

Date: 2026-11-20 · Status: accepted · Amends: ADR 0036 decision 2 (data model), `docs/spec/crm.md`
"API" and "Non-goals for v1" · Builds on: ADR 0036, ADR 0039

## Context

The founder asked on Nov 20, 2026 for companies, people and deals at parity with a real CRM
(Attio, HubSpot, Folk, Pipedrive): create, edit, find and delete; lists with sort, filter and
search; a deal board by stage; a won deal is the project. An audit of `main` against those
products found these gaps, each checked in the code:

| Gap                                                  | Evidence on `main`                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Lists sort only by name                              | `afterName`/`namePage` in `packages/db/src/crm/core.ts` are the only cursors                                                              |
| Companies and people cannot be filtered              | `crmCompaniesQuerySchema` takes `q` only; people take `q` and `company`                                                                   |
| An archived record cannot come back                  | No restore in `packages/db/src/crm/`; `archived_at` is only ever set                                                                      |
| No record can be archived or deleted from web or iOS | No call to `DELETE /api/crm/*` in `apps/web/src` or `apps/ios/src`                                                                        |
| Companies and people have no owner                   | `crm_companies`, `crm_people` lack `owner_member_id`; HubSpot, Attio and Folk have it                                                     |
| Deals have no expected close date                    | `crm_deals` lacks it; Pipedrive and HubSpot forecast by it                                                                                |
| No bulk action                                       | Every write route takes one id                                                                                                            |
| A person's page does not show their deals            | `crmPersonDetailResponseSchema` is the person and `lastContactedAt` only                                                                  |
| A deal value fails in a new workspace                | `dealValue` answers `invalid_currency` when no currency is named and none is the default, and no client names one or sets `PUT /settings` |
| Projects (won deals) have no list of their own       | Only the board's Won column, mixed with the pipeline                                                                                      |
| iOS has no board, no archive and no sort or filter   | `apps/ios/src/app/(app)/crm/index.tsx` is three name-ordered lists                                                                        |

## Decision

1. **Owners and a close date.** `crm_companies.owner_member_id` and `crm_people.owner_member_id`
   (`on delete set null`, like the deal's) and `crm_deals.expected_close_on` (a date). Additive
   columns, shipped alone before any code reads them.
2. **Sort.** Every list takes `sort` (`name`, `created`, `updated`; deals also `value`,
   `closeOn` and `stageEntered`) and `dir` (`asc`, `desc`). The cursor carries the sort key and
   the id, so pages stay stable. `lastContactedAt` is not sortable: it is computed per viewer at
   read time (ADR 0039), and sorting by it would need a scan of every record's mail.
3. **Filter.** Companies: `owner`, `domain`. People: `company`, `owner`, `hasCompany`. Deals keep
   theirs and gain `closeBefore`, `closeAfter`, `minValue`, `maxValue`. All lists: `createdAfter`
   and `createdBefore`. Filters combine with `and`; saved views stay out (ADR 0036).
4. **Restore.** `POST /:records/:id/restore` clears `archived_at` and writes a `restored` event.
5. **Bulk.** `POST /:records/bulk` with up to 200 ids and one action (`archive`, `restore`,
   `delete`, `owner`; deals also `stage`). Each id goes through the same door function as the
   single route, in one transaction per id, so every rule (signed contracts, stage transitions,
   admin-only delete) holds; the answer lists what changed and what was refused, by id.
6. **A person's deals** come with `GET /people/:id`.
7. **Currency.** The apps always send a currency with a value: the deal's own, else the
   workspace default, else the device locale's. The deal's value field gains a currency choice.
   The API keeps refusing a value with no currency at all.
8. **Projects** are deals in a `won` stage: `kind=won` already lists them. Web and iOS show a
   Projects list beside Deals, and a deal's page calls itself a project once won. No new object
   (ADR 0036, founder decision 1).

## Not now

Custom fields, saved views, several pipelines, merging duplicates and imports stay where ADR
0036 and ADR 0039 put them.

## Consequences

- Three nullable columns and six indexes; nothing is backfilled.
- The MCP `crm_write` tool gains the new fields in the layer that serves them.
