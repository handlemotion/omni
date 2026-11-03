# 0013: The index converges from IMAP alone

Date: 2026-11-03 · Status: accepted · Amends: spec v1 "Grouping messages into threads", "Sync rules"

## Context

The spec promises that Postgres is an index a full re-sync rebuilds ("Sync rules"). Nothing tested
it. A new e2e (`apps/mail/e2e/convergence.e2e.test.ts`) builds an index the way production does
(mail over IDLE, Omni's actions through the outbox, a read in Apple Mail), wipes the mailbox's
threads, messages and folders, re-syncs, and compares. It found three divergences:

1. **Threads depended on arrival order.** A re-sync imports newest first and Sent before INBOX, so
   a reply often arrives before its parent. Rule 1 only looked from a new message to its parents,
   so a parent arriving after its reply started a second thread.
2. **Read state was lost** on personal mailboxes. Omni wrote `thread_state.read` and set `\Seen`
   on IMAP, but nothing ever read `\Seen` back: a rebuild came back all unread, and a message read
   in Apple Mail never showed as read in Omni (the spec says read syncs both ways).
3. **Archive state was lost.** `threads.archived` was only set by Omni's archive route; nothing
   derived it from where the messages are, so a rebuild (or an archive in Apple Mail) came back
   in the Inbox.

## Decision

**Threading looks both ways.** When none of a new message's reply ids is stored, a stored message
that names the new message, or one of its parents, in its own `In-Reply-To` / `References` decides
the thread (`ThreadContext.relatedThreadId` in `mail-core`, `threadReferencing` in `@omni/db`).
This runs before subject matching, as rule 1 does. Two indexes keep the lookup cheap during an
import (`messages_mailbox_id_in_reply_to_idx`, GIN `messages_references_idx`).

**Read and archive follow the IMAP copies.** Every time sync records a copy, changes its flags or
forgets it, the threads of those messages are reconciled (`reconcileThreads` in `mail-sync.ts`):

- Archived: a copy in INBOX → not archived; else a copy in the archive folder → archived; else
  (Sent only, another folder, mid-move) unchanged.
- Read, personal mailboxes only: read when every copy has `\Seen`, for every member with access.
  Shared mailboxes keep read per person in Postgres, as before.

"The newer change wins" holds because IMAP only changes after Omni's own action ran: Omni writes
the row at once, the outbox changes IMAP, and the sync that follows agrees with the row.

## Consequences

- A new message in a personal thread makes it unread again (its copy has no `\Seen`), and a new
  message in INBOX brings an archived thread back. Both match what IMAP clients show.
- Between Omni's write and the outbox run, a sync that touches the same thread can briefly show
  the IMAP state again (a flicker, not a loss): the outbox's own sync settles it.
- Omni-only state is still lost if Postgres is: done, defer, per-person read on shared mailboxes,
  triage and summaries. Triage and summaries are recomputed by the AI queue; done, defer and
  shared read state have no copy on the server.
- Changes picked up from IMAP do not yet push a realtime event, so an open app shows a read or
  archive made in Apple Mail on its next refetch (window focus, the 30 s stale time).
