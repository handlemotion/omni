# 0021: Helpdesk conversation model

Date: 2026-11-12 · Status: accepted

## Context

Omni is becoming a shared-inbox helpdesk: every customer email on a shared inbox is a
conversation a team works, with a status, an owner, a priority and response targets. Personal
mail stays a mail client and comes through a Google connection.

Today a shared inbox behaves like a personal one. Done and defer are per member (ADR 0007), so
"is this handled?" has a different answer for each teammate. The `assignments` table exists but
nothing writes it. There is no place for internal notes, tags, templates, SLAs or a history of
who did what.

Rodrigo decided (Nov 12, 2026): shared status replaces per-member done/defer on shared inboxes;
resolve archives the mail on IMAP and reopen moves it back to INBOX; drafts live in Postgres
only; undo send is 5 seconds by default.

## Decision

1. **Conversation state lives on `threads`**, shared by everyone who can see the inbox:
   `status`, `assignee_member_id`, `priority`, `snoozed_until`, `customer_id`, the SLA due
   times (`first_response_due_at`, `next_response_due_at`, `resolution_due_at`),
   `first_responded_at` and `resolved_at`. Read state stays per member in `thread_state`.
   Personal mailboxes ignore these columns.
2. **Four statuses.** `open` waits on the team, `pending` waits on the customer, `snoozed`
   waits until `snoozed_until`, `resolved` is filed. Every new and existing thread starts `open`.
3. **The rules are one pure function**, `nextConversationState` in
   `@omni/mail-core/conversation-status`, so the ingest handler, the reply route, the explicit
   actions and the crons cannot disagree:
   - a customer message reopens anything that is not open, unless it is automated (auto-reply,
     out of office, bounce);
   - an agent reply moves an open conversation to pending and leaves every other status alone,
     because a reply's Sent copy can be indexed after a teammate snoozed or resolved it;
   - resolve and snooze are explicit; a snooze to a past time is refused;
   - the snooze cron wakes a conversation only if its current snooze is over;
   - reopen goes back to open.

   Every transition is idempotent, and reports `changed: false` when nothing moved so callers
   write no event and notify nobody.

4. **One assignee**, `threads.assignee_member_id`. The unused `assignments` table is superseded
   and is dropped once nothing reads it.
5. **Resolve files the mail.** Resolving enqueues the existing `archive` action; reopening moves
   the messages back to INBOX through the outbox. IMAP stays the source of truth for where mail
   is (ADR 0013); `status` is workflow state IMAP cannot hold, like read state.
6. **Everything else is Postgres-only workflow state**, never derived from or written to IMAP,
   so a full re-sync leaves it alone:
   - `conversation_events`: append-only log (status, assigned, priority, tags, note,
     first response, SLA at risk and breached), written in the same transaction as the change.
     It drives the timeline, notifications and reports. A job that may run twice sets
     `dedupe_key`, unique per conversation, so SLA alerts fire once.
   - `notes`: internal notes with @mentions; never sent.
   - `tags` per inbox (names unique ignoring case) and `thread_tags`.
   - `canned_replies`: an inbox's or one member's templates; can also set status and add tags.
   - `sla_policies` (per inbox and priority, in minutes) and `business_hours` (one per inbox).
     SLA clocks run while a conversation is `open`; the indexes cover that. The SLA ADR may
     change the rule with an additive index.
   - `customers`, per org keyed by address, filled on ingest; threads point at theirs.
   - `uploads`: files staged in R2 for a send, expired if never sent.
   - `drafts`: shared with the inbox, Postgres only (not mirrored to IMAP Drafts), with a
     `version` so a stale autosave cannot overwrite a teammate's.
   - `signatures`: an inbox's, or a member's on that inbox.
   - `member_preferences`: notification channels per kind, theme, undo-send seconds (default 5).
   - `notifications`: assignment, mention, customer reply, SLA at risk and breached, with a
     `dedupe_key` per member.
7. **Undo send uses `mail_actions.run_after`.** A send is queued with `run_after = now + window`.
   The mail service's claim already skips rows before `run_after`, so cancelling inside the
   window deletes the pending row before anything is claimed. The plan named a separate
   `not_before` column; it would have needed a second check in the claim query for the same
   effect, so it is not added.
8. **Mail-level additions** for the same work: action kinds `trash`, `spam`, `not_spam`; folder
   roles `junk` and `drafts`; `attachments.inline` and `content_id`; `messages.remote_image_count`; and
   `messages.notify_pending`, which the mail service keeps set until the Worker accepts a
   message's `message.created`, so a crash or Worker outage cannot skip ingest (the status rule,
   triage, SLA start).
9. **Contracts** (`@omni/contracts`): send payloads gain `fromName` (agent name on the inbox
   address), `inReplyToMessageId` and `attachments` (upload ids or stored attachment ids, for
   forward); payloads for the new action kinds; and the helpdesk realtime events
   `thread.changed`, `note.created`, `presence`, `action.succeeded`, `sla.at_risk`,
   `sla.breached`, which carry ids only.

## Relation to ADR 0007

This supersedes ADR 0007 **for shared inboxes only**. On a shared inbox, the views are Unassigned,
Mine, Open, Pending, Snoozed, Resolved and SLA at risk, read from `threads`; per-member done and
defer do not apply. Personal mailboxes keep ADR 0007 unchanged (`thread_state.done_through`,
`snoozed_until` as defer).

## Consequences

- Losing Postgres loses workflow state (status, assignee, notes, events), as it already loses
  read state. IMAP still holds every message and where it is filed.
- A conversation's status and its IMAP folder can briefly disagree while an archive or move is
  in the outbox. The status is what the app shows; the mail converges.
- Status no longer depends on `last_message_at` the way done does, so a message with a wrong
  `Date` header still reopens a conversation: ingest applies the rule per message, not by
  timestamp.
