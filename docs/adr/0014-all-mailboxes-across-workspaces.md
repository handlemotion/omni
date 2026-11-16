# 0014: "All mailboxes" spans every workspace

Date: 2026-11-04 · Status: accepted, amended 2026-11-16 (workspace isolation) · Amends: spec v1
"Data model" (all reads go through `db.forMember`)

## Context

The sidebar's mailbox switcher (handlemotion/omni#76) shows one "All mailboxes" row above the
per-workspace groups, and its count already covers every workspace the user belongs to. Opening it
listed only the active organization's threads: every mail read went through
`forMember(db, memberId)` for the session's active member, and a user has one member per
organization. The spec says every read goes through `db.forMember(memberId)`, so a list that
mixes organizations is a departure from it.

## Decision

**A user-scoped read path, built from the member one.** `@omni/db` has one query builder,
parameterized by whose grants count: `forMember(db, memberId)` (that member) and
`forUser(db, userId)` (any member of that user). Every query keeps the joins `forMember` always
had: `mailbox_access` to a grantee, and `members` requiring the row's org to be that grantee's
org. So a user sees exactly the union of what their members can see: a grant that crosses orgs,
or a mailbox no member of theirs was granted, still opens nothing. Every row keeps its `org_id`.

**Per-member state stays per member.** Read, done and deferred come from the `thread_state` row
of the member whose grant shows the thread, i.e. the user's member in the thread's org. A user has
at most one grant per mailbox (one member per org), so each thread appears once.

**The API.** `GET /api/threads`, `GET /api/counts` and `GET /api/search` take `scope=workspace` (the default, as
before) or `scope=all` (every workspace). Counts rows now carry `orgId`. The cursor is the same
`(last_message_at, id)` pair, so pagination works across the merge.

**Thread routes act as the thread's member.** Every `/api/threads/:id/*` route (read, state,
done, defer, archive, move, reply, attachments, message HTML) first finds the user's member who
can see the thread (`forUser(...).memberFor(threadId)`) and runs as that member: its outbox rows,
idempotency keys, rate limits and state rows are that member's. Opening or acting on a thread from
another workspace therefore needs no workspace switch. A thread none of the user's members can
see falls back to the active member and answers 404, as before. `GET /api/actions/:id` reads any
of the user's members' actions, so a reply sent from another workspace can be rechecked after a
reconnect.

**The web app.** Thread lists and counts always ask for `scope=all`. With no mailbox chosen
("All mailboxes"), Inbox, Queue, Done, Archive and All mail span every workspace; rows name their
workspace when the user has more than one. Choosing a mailbox still switches to its workspace
(`openMailbox`), because compose, search and settings are per workspace.

**Realtime: one socket per workspace.** `GET /api/realtime?org=<id>` opens the socket for the
user's member in that org (404 for an org they don't belong to); without `org` it is the active
member's, as before. The web shell keeps one per workspace, using the existing per-org Durable
Objects unchanged. We chose this over refetching on focus because "All mailboxes" is now the
screen the app opens to: new mail from any workspace should appear while you look at it, not the
next time the tab regains focus. Users belong to a handful of workspaces, so a handful of sockets
is cheap, and the Durable Object hibernates them between events. A side effect, wanted: the
user is online in every workspace, so the push fallback for offline members (`broadcast`) no
longer pings their phone for mail they are already watching on the web.

## Consequences

- `forMember` remains the only way to read mail; `forUser` is the same code with a wider grantee
  set, so new reads get both scopes and one isolation proof covers both
  (`packages/db/e2e/for-member.e2e.test.ts`, `apps/worker/e2e/all-workspaces.e2e.test.ts`).
- The extra lookup on thread routes is one indexed join per request.
- Search takes the same `scope` (`GET /api/search?scope=all`), and the web app searches every
  workspace; each hit carries its `orgId`.
- If a user ever had two members in one org (Better Auth prevents it; the schema does not), a
  thread in that org would list once per member.

## Amendment (2026-11-16): "All" stays inside the active workspace

Founder's decision: "All mailboxes" respects workspace isolation. Spanning every workspace meant
a Personal space with no mailboxes of its own still listed, counted and searched Acme's mail
under "All", so no workspace was ever a separate place.

- **What "All" means now:** every mailbox of the **active** workspace that the member can see,
  and nothing from another workspace. A workspace with no mailboxes shows the empty mail state.
- **Server, so every client gets the same answer:** `GET /api/threads`, `/api/counts` and
  `/api/search` read as the active workspace's member (`forMember`) whatever `scope` says.
  `scope=all` is still accepted (old web tabs and iOS builds send it) and ignored; they now see
  fewer threads, which is the intent. The parameter goes in a later contract step. A request that
  names a `mailboxId` still runs as the member who can open that mailbox (ADR 0024), as before.
- **Web:** lists, counts and search stop sending `scope=all`; the mailbox menu lists only the
  active workspace's mailboxes, and another workspace is chosen from the sidebar's workspace
  menu; rows no longer name their workspace. Realtime: only the active workspace's socket stays
  open, so the push fallback covers other workspaces' mail again. Another workspace's socket
  opens only while (a) one of its threads is on screen (opened by link) or (b) a send from one
  of its addresses (a reply or new mail) has not had its result yet, and closes once neither
  holds. Send responses carry the action's `orgId` for this (additive).
- **Unchanged:** `forUser` and its isolation proof; `GET /api/mailboxes?scope=all` (compose can
  still send from any address the session can open, ADR 0024); thread routes still open a
  thread by id as the member who can see it, so a link to one still works; `?org=` sockets.
- **MCP keeps its reach (ADR 0029).** An agent has no active workspace: the person chooses at
  consent whether its grant covers every workspace or one, and that choice stands.
