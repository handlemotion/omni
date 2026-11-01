# 0005: Keep tenant isolation in `forMember`; no Postgres row-level security yet

Date: 2026-10-31 · Status: accepted

## Context

Every member read goes through `db.forMember(memberId)` (and the member-scoped helpers in
`packages/db/src/member-mail.ts`), which inner-join `mailbox_access` for the member and `members`
to require the row's org to be the member's org. `e2e/for-member.e2e.test.ts` proves each read
path leaks nothing, including a forged grant that crosses orgs. The open question was whether
Postgres row-level security (RLS) should back this up, so a route that skipped `forMember` would
still see nothing.

RLS needs the member on the connection: each request runs in a transaction that first calls
`set_config('app.member_id', ..., true)`, through Hyperdrive's pooled connections. Policies on
`threads`, `messages`, `message_locations`, `attachments` and `thread_state` would repeat the
grant-and-org check, and the mail service and AI consumer would connect as a second role with
`BYPASSRLS`.

We measured it on the `perf:seed` database (200k messages): with a policy on `messages`, a
search for a rare token went from an index lookup to a sequential scan of every message, 775 ms;
a medium term took 436 ms. Postgres only applies a non-leakproof operator before the policy
check, and full-text match (`@@`, `ts_match_vq`) is not leakproof, so the GIN index cannot be
used under RLS.

## Decision

No RLS for now. Isolation stays in `forMember` and its e2e leak tests.

## Why

- RLS as written would undo the search work in this change (search back to hundreds of
  milliseconds per query), and making it fast means duplicating the access check inside every
  query anyway, which is what `forMember` already does.
- It adds a transaction and a `set_config` round trip to every request over Hyperdrive, a second
  database role, and more setup for self-hosters.
- The risk it covers, a route that queries mail tables directly, is cheaper to stop at review
  time: a `scripts/check-*.mjs` policy that fails CI when `apps/worker` route code imports mail
  tables from `@omni/db/schema`.

## Revisit when

Another service or person gets direct SQL access to the database (BI, support tooling), or a
second team writes routes. Then put RLS on the tables those clients read, with leakproof-friendly
policies, and re-run `pnpm --filter @omni/db perf:explain` before and after.
