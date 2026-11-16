# 0044: On a Google account, Gmail's read is Omni's Done

Date: 2026-11-16 · Status: accepted · Amends: ADR 0007 (Done never touches IMAP), ADR 0023, spec v1 "Sync rules"

## Context

Done is per-member state in Postgres (ADR 0007) and read syncs both ways with `\Seen` on a
personal mailbox (spec, "Sync rules"). On a Google account that left two problems. Mail handled
in Gmail still sat in Omni's Inbox, because Gmail has no Done and nobody archives there. And
opening a thread in Omni marked it read in Gmail, where read is the only "I dealt with this" a
person has. Rodrigo's decision: for a Google account, Done equals Gmail's read, in both
directions; Omni's own read indicator stays inside Omni; Done never archives or deletes.

## Decision

Applies to mailboxes with provider `gmail`. Every other mailbox behaves as before.

1. **Done in Omni marks the mail read in Gmail.** A thread that is now done has every copy flagged
   `\Seen` through the outbox (`mark_read`). Nothing is moved: the mail stays in Gmail's Inbox.
2. **Read in Gmail is Done in Omni.** When every stored copy of a thread's messages has `\Seen`,
   the thread is done through its newest message, read, and out of Later.
3. **Unread in Gmail is not done.** A done thread with an unread copy goes back to the Inbox,
   unread. New mail arrives unread, so it reopens its thread as before.
4. **Not done, and Later, mark the newest message unread in Gmail** (`mark_unread` on that
   message only, as Gmail's own "mark as unread" leaves the rest read). Without it the next sync
   would find the thread read and make it done again.
5. **Omni's read indicator is local.** Marking a thread read or unread in Omni writes Postgres
   only, as on a shared mailbox. Sync turns a thread unread only when a message that Gmail shows
   unread is first indexed, and turns it read only together with done.
6. **Existing mail.** A sync reports only flags that change, so on every connect the mail service
   reconciles the threads in INBOX against the flags it has stored. Mail read in Gmail before this
   shipped becomes Done on the first connect after it.
7. **Fast path.** Gmail keeps a second copy of every message in All Mail and IDLE watches only
   INBOX, so a flag event on a Gmail connection also syncs All Mail. Otherwise "every copy read"
   would wait for the hourly poll.

## Consequences

- Done on a Google account now reaches IMAP, which ADR 0007 said it never would. It is still
  never an archive, move or delete.
- A Google account is a personal mailbox with one owner, so "per member" and "per mailbox" are
  the same person. Shared inboxes keep ADR 0007 and ADR 0032 unchanged.
- Replying keeps a done thread done: Gmail files the reply in Sent as read.
- A thread put in Later and then read in Gmail becomes done. That is the rule, not a bug.
- A full re-sync converges on Gmail: done exactly where Gmail shows read. Omni-only state (which
  not-done threads were opened here) is lost with Postgres, as ADR 0007 already accepts.
- **First connect after this ships:** threads marked done in Omni that Gmail still shows unread
  (done from the list without opening) return to the Inbox once.
- **Deploy order.** The Worker and the mail service deploy independently. While an old Worker
  runs beside the new mail service, opening a thread still queues `mark_read`, which the new
  rule turns into Done. The window is the minutes between the two deploys and each case is one
  click to undo; a second action kind to tell the two apart was not worth carrying forever.
- Proven by `packages/db/e2e/gmail-done.e2e.test.ts` (the sync rule),
  `apps/worker/e2e/triage-views.e2e.test.ts` (what the API queues) and
  `apps/mail/e2e/service.e2e.test.ts` (the round trip over real IMAP). GreenMail has no All Mail,
  so decision 7 is checked only against a real Google account.
