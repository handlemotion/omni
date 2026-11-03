# 0007: Done and defer are per-member state, separate from archive

Date: 2026-11-03 · Status: accepted

## Context

Omni triages mail the way done-based email apps do (Superhuman, Hey, Spark). The sidebar has
four views:

- **Inbox**: threads still waiting for you, meaning not done and not deferred.
- **Queue**: threads deferred until a time. They leave the Inbox and come back when the time is up.
- **Done**: threads you finished.
- **All mail**: every thread you can see, whatever its state.

The spec has `thread_state (read, snoozed_until)` per member and a thread-level
`threads.archived` that syncs to IMAP. Archiving moves the messages out of INBOX on the server,
so on a shared mailbox it affects everyone (spec: "Sync rules"). The spec does not define Done.

The question was whether Done reuses archive (an IMAP move, shared) or is its own per-member
state.

## Decision

1. **Done is per-member state in Postgres.** `thread_state` gets `done_through timestamptz`. A
   thread is done for a member while `threads.last_message_at <= done_through`. Marking done
   sends nothing to the outbox and never touches IMAP. Archive stays as it is: a separate,
   shared action that files mail on the server.
2. **A new message brings a done thread back to the Inbox.** This follows from the rule above:
   when a newer message arrives, `last_message_at` moves past `done_through`. No job runs and
   no row is rewritten.
3. **Done covers what the member saw.** `POST /threads/:id/done` takes
   `{ through: <the thread's lastMessageAt as shown> }`. The server caps it at the thread's
   current `last_message_at`. If a message arrived after the screen was drawn, the answer is
   `done: false` and the thread stays in the Inbox, so a click never hides mail the member has
   not seen. Using the thread's own timestamp, not `now()`, also means a message that took a
   while to arrive (its `Date` is after the newest message seen, but it was indexed after the
   click) still reopens the thread.
4. **Defer reuses `snoozed_until`.** The column keeps its name, because renaming a column is
   destructive. The API and app say _defer_ and _Queue_: `POST /threads/:id/defer { until }`,
   `DELETE /threads/:id/defer`, view `queue`, `deferredUntil` on thread rows, and `queue` in
   `/counts`. The `snoozed` view and `snoozedUntil` on `PATCH /threads/:id/state` are replaced,
   so there is one way to do each thing. `PATCH /threads/:id/state` now only sets read.
5. **Done and deferred exclude each other.** Marking done clears the deferral, and deferring
   clears done. The queries also let done win if both are ever set.
6. **Views** (`ThreadView` in `@omni/db`):

   | View      | Rule                                 |
   | --------- | ------------------------------------ |
   | `inbox`   | not archived, not done, not deferred |
   | `queue`   | not archived, deferred, not done     |
   | `done`    | done (archived or not)               |
   | `archive` | archived                             |
   | `all`     | everything the member can see        |

   `counts()` reports `inbox`, `unread` and per-lane counts under the Inbox rule, plus `queue`.

## Why not reuse archive

- **Shared mailboxes.** Done has to be per person: hello@ can be done for Ana and still waiting
  for Bea. An IMAP move is one state for everyone, so it cannot express that.
- **Source of truth.** The spec keeps per-person state (shared-mailbox read state) in Postgres
  only. Done is the same kind of state. Purelymail stays the source of truth for mail, and a
  re-sync of the mailbox converges: `upsertMessage` keeps each message's thread, `thread_state`
  is not derived from IMAP, and `last_message_at` only moves forward. As with read state, losing
  Postgres entirely loses done and defer state, which IMAP cannot hold.
- **Reopening.** IMAP has no "bring this back when someone replies". The server files a reply in
  INBOX, but the thread's older messages stay in Archive. With a watermark, reopening needs no
  extra code.

A personal-mailbox Done that also archives on the server (as Superhuman does with Gmail) is
possible later, as an option on top of this. It is not part of this change.

## Consequences

- **Any newer message reopens the thread, including your own reply** (once the Sent copy is
  indexed) and a teammate's reply on a shared mailbox. If "send and mark done" is wanted, the
  client marks done after the reply arrives.
- **Timestamps, not message ids.** `last_message_at` is the newest `Date` header in the thread.
  A message dated at or before the newest one the member had seen (a wrong sender clock, or two
  messages in the same second, since `Date` has one-second precision) does not reopen the thread.
- **A deferred thread does not come back early on a new message.** It returns at its time,
  as snoozes did before this change. A reply that should end a deferral is a follow-up.
- **Idempotency.** Every done and defer request requires an `Idempotency-Key` header, like the
  outbox actions, so clients keep one contract. Nothing reaches the outbox, and each request
  sets absolute values, so a retry writes the same row (proven in
  `apps/worker/e2e/triage-views.e2e.test.ts`). No background job is involved.
- **Cost.** The Inbox filter is one primary-key lookup on `thread_state` per scanned thread,
  inside each mailbox's page scan. All mail and Done ignore `archived`, so they get a new index,
  `threads_mailbox_all_page_idx (mailbox_id, last_message_at desc, id desc)`. On the `perf:seed`
  database, with a member who has marked 22k of their threads done, the Inbox list (12 mailboxes)
  takes 17 ms, the same as before. In the worst case, where every one of the member's 9,108
  unarchived threads is done and the Inbox is empty, it takes 56 ms, because the scan walks
  every thread to find none. If mailboxes grow far past this, the fix is a per-member inbox
  index table kept up to date by the writers. Not needed at v1 scale.
