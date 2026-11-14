# 0031: Personal triage on shared inboxes

Date: 2026-11-14 · Status: accepted · Amends: ADR 0021 ("Relation to ADR 0007") · Decisions 2, 3 and 5 superseded by ADR 0032

## Context

ADR 0021 gave shared inboxes a team status (open, pending, snoozed, resolved), an owner and
helpdesk views, and turned per-member Done and Later off there: on a shared inbox, the status was
the only triage. In use that made two jobs one:

- **Is the customer taken care of?** One answer for the whole team: the conversation's status.
- **Do I still need to look at this?** A different answer per person.

With only the first, every open shared conversation sat in every teammate's Inbox until someone
resolved it, including the ones a teammate owned or that were waiting on the customer, and nobody
could clear one from their own Inbox without changing it for the team.

Rodrigo decided (Nov 14, 2026) to separate them, with one coupling kept.

## Decision

1. **Done and Later are per member on shared conversations too**, exactly as ADR 0007 and ADR
   0027 define them on personal threads (`thread_state.done_through`, `snoozed_until`). They never
   change the conversation's status, owner or IMAP folder. The conversation toolbar shows them
   beside Resolve and Snooze.
2. **The Inbox holds what concerns you.** A thread is in a member's Inbox (list and counts) when
   it is not archived, not done or in Later for them, and it is either `open` and unassigned or
   theirs, or `pending` and theirs. Replying claims an unassigned conversation and makes it
   pending, so what you answered stays in your Inbox under Awaiting reply, as answered personal
   mail does. Snoozed and resolved conversations, and ones a teammate owns, are in nobody else's
   Inbox. Personal threads always pass the rule: their status is never moved from `open`
   and they have no owner (ADR 0021), so no mailbox-kind join is needed.
3. **Resolve is everyone's.** A resolved conversation leaves every Inbox and every Later at once,
   by status, without waiting for the IMAP archive to land. Later also excludes resolved.
4. **A customer's new message brings it back.** The status rules reopen the conversation, and
   `last_message_at` moving past `done_through` undoes each member's Done. Nothing new runs.
5. **The team's queue stays one click away.** For a shared inbox, the sidebar shows Open (every
   open conversation, whoever owns it) beside Mine. The team's Snooze gets its own glyph, so it
   is not mistaken for your Later.

## Not included

- **@mentions in the Inbox.** A note does not move `last_message_at`, so "mentioned since you
  marked it done" would fight the Done rule (marking Done again could not clear it). Mentions
  already reach the member as notifications.

## Consequences

- A teammate's conversation can sit in your Later; it leaves when the team resolves it.
- Assigning a conversation to someone removes it from everyone else's Inbox at once; unassigning
  returns it.
- The Inbox counts and lists use the same rule, so badges and lists agree.
