# 0032: CRM forwarding address

Date: 2026-11-14 · Status: accepted · Extends: spec v1 "Sending", "Data model"

## Context

We want our email in Attio, on the person and company records it belongs to. Attio offers two ways
in: a full mailbox sync (Google or Microsoft only, so not our Purelymail mailboxes), or a
**forwarding address** (`<workspace>@attio.email`) that files any mail sent or forwarded to it.
Attio's rules for that address ([docs](https://attio.com/help/reference/email-calendar/email-forwarding)):

- It accepts mail only **from the address the member logs into Attio with**. Anything else is
  dropped silently.
- A BCC files the message on its participants' records.
- A forwarded chain is filed on the participants of the **most recent** message in it.

Doing this by hand (BCC every send, forward every reply you get) does not happen. Purelymail's own
forwarding rules cannot do it either: they relay with the original sender, which Attio drops.

HubSpot, Pipedrive and Salesforce work the same way (a "BCC address"), so we build the generic
thing, not an Attio integration. Attio is the first one we test against.

## Decision

1. **A mailbox can have one forwarding address.** New nullable columns on `mailboxes`:
   `forward_address` (text) and `forward_scope` (enum, below). Null means off. Personal mailboxes
   only in v1: Attio only accepts mail from a member's own login address, and `hello@` is not one.
   That covers every personal mailbox alike, in a personal space and in a company workspace
   (ADR 0024): both are `kind = personal`.
   No Attio-specific values in code; any address works (self-hosting).
2. **What gets forwarded** (`forward_scope`):
   - `sent`: every message you send from Omni.
   - `conversations` (default): `sent`, plus every message you receive in a conversation you have
     written in. Your first reply in a thread also forwards the received messages before it, so the
     record shows the whole exchange. Newsletters, notifications and spam never reach the CRM.
   - `all`: `sent`, plus every message that lands in the Inbox folder (not Spam).
3. **Sent mail: envelope BCC.** The outbox adds the forwarding address to the SMTP envelope's
   recipients only. No header changes: the people you write to never see it, and the Sent copy is
   the same message they got.
4. **Received mail: a forward from your own address.** The mail service sends a copy to the
   forwarding address over the mailbox's own SMTP: `From:` the mailbox address, `Fwd: <subject>`,
   the original's headers and text under the standard "---------- Forwarded message ---------"
   divider (`@omni/mail-core` `forwardBody`, the one Omni's own forwards use), with its
   attachments. Attio's docs describe exactly this (a member forwards; the copy is filed on the
   forwarded message's participants). A redirect (the original re-sent unchanged) was dropped:
   its `From:` is the original sender, which Attio's rule says it drops.
5. **It runs on the outbox.** Each forward is a `mail_actions` row of a new kind, `forward_copy`,
   with idempotency key `forward:<mailbox_id>:<message_id>`: a re-sync, a retry or a second worker
   never sends the same copy twice, and failures retry with backoff like any send. A forward copy
   is never appended to Sent and never indexed as a message. Messages from the forwarding address
   itself are ignored, and a mailbox cannot forward to its own address (no loops).
6. **Only new mail.** `mailboxes.forward_since` is when the address was set. Mail dated more than
   5 minutes before it (senders' clocks) never qualifies by itself, so history import and re-syncs
   queue nothing; the only older mail sent is the thread backfill in 2 (at most 25 messages).
7. **API** (Worker, owner of the mailbox only; through `db.forMember`):
   - `GET /api/mailboxes/:id/forwarding` → `{ address, scope, lastForwardedAt, lastError }`
   - `PUT /api/mailboxes/:id/forwarding` `{ address, scope }` · `DELETE` turns it off.
     `lastError` comes from the latest failed `forward_copy` action, so the settings row can show
     "In sync" or the failure.
8. **Settings.** A Forwarding page in the web app's personal settings lists each of your personal
   mailboxes, across every workspace, with its forwarding address, scope and status. iOS can follow.

## Consequences

- Every forwarded message is one more SMTP submission from the member's mailbox. At our volume
  that is far inside Purelymail's limits; `all` on a busy mailbox is the case to watch.
- A crash between SMTP's OK and marking the row done can send one copy twice (sends avoid this
  by finding their Message-ID in Sent; copies are not filed there). Attio dedupes on Message-ID
  is not relied on: a rare duplicate on a record is accepted.
- Schema is additive (`forward_address`, `forward_scope`, `forward_since`, one enum, one
  `mail_action_kind` value): old code ignores it.

## Verification

- E2E (`apps/mail`, real GreenMail): a send with forwarding on reaches the forwarding address and
  every recipient, and no recipient's copy names it; a received message in a thread you replied in
  is forwarded once, `From:` the mailbox, even when sync runs twice; a newsletter is not
  forwarded under `conversations`; history import forwards nothing.
- E2E (`apps/worker`): only the mailbox owner can read or change the setting.
- Live (approved Nov 14, 2026): one send and one received reply from a test
  mailbox to your Attio forwarding address, then check both appear on the right Attio record. This
  confirms Attio files the inline forward on the original sender (decision 4).
