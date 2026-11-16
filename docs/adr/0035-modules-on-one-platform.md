# 0035: Omni is modules on one platform

Date: 2026-11-16 · Status: accepted · Amends: spec v1 "Non-goals" (calendar, contacts, file
storage) and "Clients and monorepo", AGENTS.md "Architecture" and "Parallel agents" (proposed
text below) · Extends: ADR 0034

## Context

Omni started as one inbox. ADR 0034 added Storage, ADR 0036 adds a CRM, and more will follow
(calendar, contacts). The product is becoming the set of tools a company runs on, and the code
has to let each tool grow without the others slowing it down. The full picture is in
`docs/spec/modules.md`.

Three things are true in the code today:

- **Storage already has a shape.** It is one schema file, one folder in `@omni/db` behind one
  surface file (`storage.ts`), one contract file, a set of Worker routes and its own e2e files.
  Nothing wrote that shape down, so the next module could pick a different one.
- **Mail has none.** `packages/db/src` holds about 50 flat files. `schema/mail.ts` (1,359
  lines) holds mail, helpdesk, billing and workspace-setup tables. `for-member.ts` (1,413
  lines) is on the lint debt list.
- **The parallel-work rule is per package** ("two stacks never edit the same package"). Every
  module lives in `@omni/db` and `@omni/worker`, so two module stacks always break it.

The founder asked (Nov 16, 2026) for shared code, cleaner modules, each tool able to scale on
its own, the tools connecting and enriching each other, and for Purelymail's DAV protocols to be
considered as the connection.

## Decision

### 1. A module is a slice of the one platform, not a service

One Worker, one database, one sign-in, one bill. A module is a vertical slice through the
packages that already exist. The mail service stays the only second process, because IMAP needs
connections that stay open.

"Scale each cleanly" means two things here, and the layout below gives both:

- **Change.** A module can be built, reviewed and tested without reading another module.
- **Growth.** A module's tables are its own and nothing else queries them (decision 4). If one
  ever needs its own database or its own Worker, its surface becomes a service binding and its
  callers do not change.

### 2. The platform is what every module uses and none owns

| Platform piece           | Where                                             | Set by           |
| ------------------------ | ------------------------------------------------- | ---------------- |
| People and workspaces    | `@omni/auth`, `schema/auth.ts`, `identity.ts`     | ADR 0008, 14, 24 |
| The doors                | `forMember`, `forUser`, and a module's public one | ADR 0005, 0034   |
| Plan and read-only gate  | `requireWritableWorkspace`, `inGoodStanding`      | ADR 0015         |
| Realtime, queue, crons   | `apps/worker/src` root                            | spec v1          |
| System mail, rate limits | `apps/worker/src` root                            | ADR 0020         |
| Agents                   | `/mcp`, OAuth scopes                              | ADR 0029         |
| Addresses and domains    | `@omni/mail-core` (decision 5)                    | this ADR         |
| Signing and encryption   | `@omni/crypto`                                    | spec v1          |

A module never re-implements one of these. If the platform lacks something two modules need, it
is added to the platform, in its own PR.

### 3. Every module has the same shape

| Layer           | Where                                                         | Holds                                                      |
| --------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Tables          | `packages/db/src/schema/<module>.ts`                          | Tables named `<module>_*`, each with `org_id`.             |
| Data access     | `packages/db/src/<module>.ts` and `packages/db/src/<module>/` | The surface file exports the doors; the folder is private. |
| Client contract | `packages/contracts/src/<module>.ts`                          | Zod shapes of what the Worker answers the apps.            |
| HTTP            | `apps/worker/src/<module>/`, mounted at `/api/<module>`       | Routes. They call doors and never query tables.            |
| Jobs            | `apps/worker/src/<module>/jobs.ts`                            | Minute and daily work, each safe to run twice.             |
| Agents          | `apps/worker/src/<module>/mcp.ts`                             | Tools, behind scopes `<module>:read`, `<module>:write`.    |
| E2E             | `<package>/e2e/<module>-*.e2e.test.ts`                        | Leak tests for every door first.                           |
| Web             | `apps/web/src/components/<module>/`, `lib/<module>.ts`        | Rodrigo's, per `DESIGN.md`.                                |

- A module is always on. Nothing is created to enable it, and its config is optional with neutral
  defaults, so a self-hosted install gets every module with no new required service.
- A module is included in the flat plan (ADR 0015). It gets a meter only when its cost grows
  with use and has no ceiling, as Storage's bytes do (ADR 0034 decision 7).
- Jobs and lifecycle hooks are registered in one list, `apps/worker/src/modules.ts`: `minute`,
  `daily`, `memberRemoved`, `workspaceDeleted`. `index.ts` walks the list for the crons, and
  the Worker hands it to `createAuth`, so `@omni/auth` runs each module's hooks without naming
  a module (before this, it named Storage in `storage-handover.ts`). Routes stay chained by hand in
  `app.ts`, one line per module, because Hono RPC infers `AppType` from the chain.
- Tables that predate this ADR keep their names. Renaming `threads` to `mail_threads` is a
  destructive migration that buys nothing.

### 4. One import rule, enforced

- A module imports the platform and its own folder.
- A module reads another module **only through that module's surface file**, which checks
  access itself. It never selects from another module's tables, even in a join.
- A schema file may name another module's table in a foreign key. That is the only exception.
- Dependencies point one way and are declared: CRM may use Mail and Storage. Mail and Storage
  know nothing of CRM, and nothing of each other in `@omni/db`.
- A feature that spans two modules (save an attachment to Storage) is a Worker route that calls
  both doors. It lives with the module whose screen starts it.

`scripts/check-modules.mjs` enforces this in `pnpm check`, like the other policy scripts. Files
that predate the rule are listed in it as debt; the list only shrinks.

### 5. Modules connect by reference, and the address is the join key

Omni already identifies people the same way everywhere: by email address. Mail participants,
Storage grants (ADR 0034), sign-in emails (ADR 0014), helpdesk customers (ADR 0021) and CRM
people (ADR 0036) are all keyed by a lowercased address, and companies by a domain (ADR 0010).
That shared key is what lets modules enrich each other without sync jobs.

1. **A link is a reference, never a copy.** One side stores the other's id with a real foreign
   key, or derives the link from an address or a domain at read time. No module mirrors another
   module's rows.
2. **A link never widens access.** Reading the far side goes through the far side's door with
   the viewer's own identity. A deal shows a thread only to a member who can already open it.
3. **The link belongs to the module that depends on the other.** A deal stores its folder's
   node id; Storage has no column about CRM.
4. **Derived links converge.** Anything computed from mail is recomputed by a re-sync
   (ADR 0013). Nothing a person typed lives only in a derived row.
5. **One normaliser.** Lowercasing an address, taking its domain and knowing which domains are
   shared webmail (`companyFromAddress` and its list, today in `@omni/db/customers.ts`) move to
   `@omni/mail-core`, pure and unit-tested, and every module calls that.
6. **Changes are announced, not pushed.** A module publishes `<module>.changed` with ids only on
   the workspace's realtime object (as ADR 0021's events do), and the apps refetch.

Which links exist, and when, is the table in `docs/spec/modules.md`.

### 6. DAV is an edge protocol, not the connection between modules

Purelymail offers WebDAV, CardDAV and CalDAV. Its own documentation
([docs](https://purelymail.com/docs/webDav), read Nov 16, 2026) sets the limits:

| Protocol | What Purelymail says                                        | What Omni does                                                                                         |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| WebDAV   | Files up to 50 MB; Basic auth per user                      | Not used. Storage stays on R2 (ADR 0034): 5 GB files, sharing, links, a meter.                         |
| CardDAV  | Address books cannot be shared between users on an account  | Not the CRM's store. Later, an optional one-way export of CRM people into a member's own address book. |
| CalDAV   | Only the basic RFC 4791; "not all features are implemented" | The base for a future Calendar module, used as IMAP is: the host holds events, Postgres is an index.   |

- Modules connect through Postgres and doors (decision 5). A protocol round trip between two
  Omni modules would be slower, would fail in more ways and would tie a self-hoster to one host.
- DAV needs a mailbox's password, which only `apps/mail` holds. So any DAV client lives in
  `apps/mail`, speaks to any standard server, and Purelymail-only behaviour stays behind the
  mailbox `provider`, as for mail.
- Calendar is its own ADR and starts with a spike against Purelymail's CalDAV, the way M0
  tested its IMAP before anything was built on it.

### 7. Parallel work is owned by module

Proposed text for AGENTS.md (not edited by this PR; that file changes only when asked):

> **Parallel agents.** Independent work gets its own stack rooted on `main`. Before starting, an
> agent names the modules it owns (a module is its folders in every package, ADR 0035); two
> stacks never edit the same module or the same platform file. Shared touch points are resolved
> by the later layer: `pnpm-lock.yaml`, root config, `docs/self-hosting.md`,
> `packages/db/migrations/` (delete your own migration, merge `main`, run `db:generate` again;
> never hand-merge the journal or a snapshot), `schema/index.ts`, `apps/worker/src/app.ts` and
> `modules.ts`.

The Architecture table gains a line saying that Mail, Storage and CRM are modules inside
`@omni/db`, `@omni/contracts` and `@omni/worker`, laid out as decision 3 says.

## Considered and rejected

| Option                                             | Why not                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Worker or service per module                     | Every deployable must work beside the previous version of every other (AGENTS.md "Database"). Three more deployables multiply those pairs, cross-module writes lose their transaction, and a self-hoster runs four things instead of one. |
| A package per module (`@omni/crm` with everything) | `forMember` composes the doors, so `@omni/db` would import the module and the module would import `@omni/db`. Drizzle wants one migration history. A lint rule gives the same boundary without the cycle.                                 |
| A generic `links` table for every pair             | No foreign keys, so nothing cascades and a dangling link is found at read time. Typed columns on the dependent module cost one column each.                                                                                               |
| A shared activity log for all modules              | Three modules do not need it. Each keeps its own events; a timeline merges them at read time. Revisit when a workspace-wide feed is wanted.                                                                                               |
| Purelymail WebDAV as Storage's backend             | Decision 6.                                                                                                                                                                                                                               |

## Rollout

1. This ADR and `docs/spec/modules.md`.
2. `scripts/check-modules.mjs` with its unit test, enforcing decision 4 for Storage and CRM,
   with mail's older files listed as debt. The AGENTS.md text, once approved.
3. CRM is born in this layout (ADR 0036). `apps/worker/src/modules.ts` arrives with it.
4. Storage's Worker files move to `apps/worker/src/storage/`: a rename-only PR, after
   Storage's own stack (ADR 0034 layers 5 and 6) has landed.
5. Mail, when no mail stack is open, one rename-only PR per step: `schema/mail.ts` splits by
   concern with no table renamed, then `for-member.ts` and the flat files move under
   `packages/db/src/mail/`. `db:generate` must report no change for each. Not a blocker for
   anything above.

## Consequences

- A cross-module read is two queries instead of a join. At our sizes that is a few
  milliseconds; `pnpm perf:explain` covers any hot path that crosses modules before it merges.
- `forMember` and `forUser` stay the only way in, and grow one property per module. Each
  module's leak tests live in its own e2e file, so `for-member.e2e.test.ts` stops growing.
- The lint rule makes some shortcuts illegal on purpose. When a module needs something from
  another, the fix is a function on that module's surface, reviewed by its owner.
- Nothing here changes a table, a route or a deploy. Steps 4 and 5 move files only.
- Losing Postgres now loses more than an index: Storage's rows (ADR 0034) and CRM's
  (ADR 0036) are the truth. Mail's part can still be rebuilt from the mail host.
