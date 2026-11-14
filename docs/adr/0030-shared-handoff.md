# 0030: Hand-off from a shared inbox to a personal mailbox

Date: 2026-11-14 · Status: accepted

## Context

On a shared inbox, every reply goes from the inbox's address with the agent's name ("Ana from
Acme", ADR 0021 §9), so the customer's answer comes back to the team. Sometimes a conversation
should leave the team and become one person's one-to-one thread: a sales lead handed to the
account owner, say. Rodrigo wants that as an explicit choice in the reply composer, not a
setting, and not a forward (a forward starts a new chain for the customer).

## Decision

1. **The From row of a shared conversation's reply offers the member's own personal mailboxes**
   besides the inbox (the default): personal, in the conversation's workspace, the member's own
   (owner grant) and `active`. The Worker checks the same rules; anything else answers 404, so
   nobody sends from a teammate's mailbox.
2. **`POST /api/threads/:id/handoff`** is a new route, not a field on `/reply`. An old Worker
   answers 404 to a new web app instead of silently sending from the shared address, and old
   clients never see it. The body is the composer's: `mailboxId`, `to`, `cc`, `bcc`, `text`,
   `html`, `messageId`, `basedOnMessageId` (409 with `messages` when stale, like a reply) and
   `attachments` staged on the personal mailbox.
3. **The send is the personal mailbox's.** The outbox row is on the personal mailbox, from its
   address, with the person's own name (as personal mail already uses), so its Sent copy is
   filed there and the customer's next reply lands in their inbox, where Omni threads it as a
   personal thread. `In-Reply-To` and `References` point at the shared thread's message, so the
   customer's client keeps one chain. `inReplyToMessageId` is left out: it would ask the mail
   service to file the Sent copy in the shared thread, which belongs to another mailbox.
4. **In the same transaction**, with the conversation row locked first: the send is queued, the
   conversation is assigned to the sender and resolved through the existing `assign` and
   `applyStatus` paths (so `nextConversationState`, SLA clocks and the archive on resolve all
   apply), and an append-only `handoff` event records who, to which mailbox and address, the
   send's action id, and the status and assignee before. The event's `dedupe_key` is
   `handoff:<actionId>`, so a retried request (same `Idempotency-Key`) finds its send and its
   event and changes nothing more. `conversation_event_kind` gains `handoff` (additive).
5. **Undo send undoes the hand-off.** The send carries `handoffThreadId` (ignored by the mail
   service). `cancelSend` deletes the outbox row and, in the same transaction, puts the
   conversation back: reopened (to `open`, whatever it was before, since nobody was answered)
   and assigned to whoever had it, both with `cause: "handoff_cancelled"`. It does so only while
   the conversation is still resolved and the sender's; a teammate who changed it inside the
   window wins. Reopening inside the resolve's archive delay drops the archive, so the mail never
   leaves INBOX; after it, the mail moves back as on any reopen.

   The alternative, changing the status only when the send leaves the outbox, needs the mail
   service to call back into the workflow, and leaves the conversation open (and assignable to
   someone else) for the length of the undo window. Applying at once and reverting on cancel
   keeps it all in the Worker and in one transaction each way.

6. **The timeline shows one line**: "Ana handed this off to ana@acme.com". The status and
   assignee events that are part of it (`cause: "handoff"`) are not shown again; a cancel shows
   "Ana cancelled the hand-off".

## Consequences

- A hand-off does not record the shared conversation's first response: the reply belongs to the
  personal mailbox. Reports that count first responses on the inbox do not see it.
- A hand-off's send that fails for good (SMTP refuses it) leaves the conversation resolved and
  handed off; the failed send shows like any other, and the member can reopen.
- Attachments must be staged on the personal mailbox. Switching From drops staged files, as new
  mail's switcher already does.
- Old web apps show the `handoff` event as nothing (they skip kinds they don't know) and the
  status and assignee events as "Ana resolved this" and "Ana took this".
