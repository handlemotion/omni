# 0032: On a shared inbox, Done is personal and the ticket lives in the rail

Date: 2026-11-14 · Status: accepted · Supersedes: ADR 0031 decisions 2, 3 and 5

## Context

ADR 0031 made Done and Later per member on shared conversations, and filtered each member's Inbox
to what "concerns" them: open and unassigned or theirs, or pending and theirs. In use that coupled
two things Rodrigo wants apart. A teammate taking or answering a conversation hid it from
everyone else, though whether you are finished with a conversation is your own call.

The ticket model itself (status, owner, priority, tags, SLA, reports) was never the problem, and
is kept for teams that grow into it. What changes is where it shows and what it may hide.

The conversation toolbar also changed with the kind of thread: Resolve and Snooze on a shared
conversation, Archive on a personal one. The same place on screen meant different things.

Rodrigo decided (Nov 14, 2026):

## Decision

1. **Done and Later are the only things that take a conversation out of your Inbox.** A shared
   conversation stays in each teammate's Inbox, list and counts, until that teammate marks it
   done or moves it to Later, whoever owns it, whatever its status, whoever replied. The views go
   back to the ADR 0007 rule (not archived, not done, not in Later) with no ticket filter. Resolve
   still files the mail on the server (ADR 0021), so a resolved conversation leaves every Inbox
   once that archive lands.
2. **The toolbar is the same on every thread**: Done, Later, read state, full screen. Resolve,
   Snooze and Archive are not in it.
3. **The rail under the title is the shared ticket**: status (Reopen, Resolve, Snooze), owner,
   priority and tags, each a menu, as before. The team's Snooze uses its own glyph
   (`IconClockSnooze`), so it is not mistaken for your Later.
4. **The sidebar keeps Mine and drops Open.** With the Inbox holding every conversation again,
   Open was the same list.
5. **A hand-off stays as ADR 0030 has it**: it assigns the conversation to the sender and resolves
   it, because the conversation has left the team for one person's mailbox. That is the one case
   where it leaves teammates' Inboxes without their Done: resolving files the mail. Its timeline
   line reads "Ana continued this conversation in their inbox".

## Consequences

- On a shared inbox, everyone clears every conversation themselves. That is the intended cost
  for small teams; the ticket model (owner, status, Mine, SLA) is there when a team needs more.
- The helpdesk list views (Mine) still bind `e` and `h` to Resolve and Snooze; aligning those keys
  with the toolbar is a follow-up.
- A handed-off conversation is resolved for the team; the customer's next reply goes to the
  personal mailbox, so it does not reopen.
