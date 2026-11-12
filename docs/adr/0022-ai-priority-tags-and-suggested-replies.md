# 0022: AI priority, tags and suggested replies

Date: 2026-11-12 · Status: accepted · Extends ADR 0002 and ADR 0021

## Context

The spec (`docs/spec/v1.md`, "Non-goals for v1") listed drafted replies as a v2 candidate. The
helpdesk pivot (ADR 0021) makes them part of the product: Rodrigo decided (Nov 12, 2026) that AI
suggested replies are in scope, on demand and never sent on their own. The same plan has triage
set a conversation's priority, suggest tags from the inbox's list, and resolve noise, so a support
team's queue starts sorted.

Triage runs on Jev in production and on Claude for self-hosters without a TypeSafe key
(ADR 0002). Whatever we add has to work on both.

## Decision

### Priority, tags and noise come from triage

1. On a shared inbox, when the latest message is a customer's, triage asks more in the **same
   request**: on Jev, four Nouls (sender blocked, time-sensitive, money at stake, sender upset) and
   one Noul per inbox tag (the first 25); on Claude, `priority` and `tags` join the structured
   output, with tags an enum of the inbox's names so the model cannot invent one. The bucket
   questions and their truth table do not change, so recorded personal-mail answers stay valid.
2. Priority is a truth table in code (`packages/ai/src/helpdesk.ts`): a message that asks nothing
   (`fyi`, `noise`) is `low`; blocked and time-sensitive is `urgent`; any one of the four is
   `high`; otherwise `normal`. Only a settled yes raises it. Up to three tags whose Noul reads yes
   are added, most likely first.
3. The queue applies them through the workflow's own change function, with no actor and
   `source: "ai"` in the event, and never over a person: priority is left alone once a member has
   set it on that conversation, and a tag a member removed is not added back.
4. Noise filed at the auto-file confidence (0.85) resolves the conversation through the same
   status rule a person's resolve uses (`resolve` in `@omni/mail-core/conversation-status`), so it
   is archived on IMAP and a customer's next real message reopens it. Personal mailboxes keep their
   lanes; nothing here touches them.
5. A member's change to an AI-set priority, or removal of an AI-added tag, is recorded in
   `triage_feedback` (field, from, to), next to bucket re-sorts, to measure accuracy before tuning.

### Suggested replies are on demand

6. `POST /api/threads/:id/suggested-reply` drafts one reply to the latest customer message from
   the cleaned conversation (newest messages first, about 6k tokens) and up to 20 of the inbox's and
   the agent's canned replies, which the prompt treats as the team's own wording and policy. It
   returns plain text for the composer; it never writes a draft, queues a send, or stores the text.
7. It runs on Claude only (Jev does not generate text), on `claude-opus-5-5` at medium effort,
   with server-side fallback when the model declines. A reply customers read is worth the stronger
   model, and it runs only when an agent asks, so volume is low (roughly 1-2 cents a draft).
8. Each call counts toward the workspace's daily token cap (`AI_DAILY_TOKEN_CAP`). Over the cap
   the route answers 429 and the composer offers no suggestion; triage itself keeps its monthly
   allowance (ADR 0015) and ignores the daily cap, as before.
9. Email text is untrusted: it sits in one `<email_data>` block the system prompt fences off, as
   in summaries. The prompt forbids inventing facts and asks for `[placeholders]` where one is
   missing. Output is stripped to plain text and capped at 4,000 characters.

## Consequences

- A support inbox's queue arrives prioritized and tagged, and noise leaves it, without new
  requests: the extra questions ride on the triage call that already runs per message.
- Self-hosters on Claude get the same features; without an Anthropic key there are no suggested
  replies, and triage without a model sets no priority or tags.
- The priority wording and table, and the tag question, need live checks on real support mail
  before we trust them; `triage_feedback` is where we will see whether they hold.
- Suggested replies can be wrong. They are a draft in the agent's hands, never sent unread.
