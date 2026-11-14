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
   forwarding address over the mailbox's own SMTP, `From:` the mailbox address, so Attio accepts
   it. Format, in order of preference, settled by one live test against Attio:
   1. **Redirect**: the original message re-sent unchanged (`From`, `To`, `Date`, `Message-ID`
      intact), envelope sender = the mailbox. Best fidelity, and Attio files it on the real
      sender. Only usable if Attio accepts an envelope match.
   2. **Inline forward**: a new message `From:` the mailbox with the original quoted in the
      standard "Forwarded message" block. Attio parses that block for the participants.
5. **It runs on the outbox.** Each forward is a `mail_actions` row of a new kind, `forward_copy`,
   with idempotency key `forward:<mailbox_id>:<message_id>`: a re-sync, a retry or a second worker
   never sends the same copy twice, and failures retry with backoff like any send. A forward copy
   is never appended to Sent and never indexed as a message. Messages from the forwarding address
   itself are ignored (no loops).
6. **Only new mail.** Turning it on does not backfill history (beyond the thread backfill in 2).
   History import never enqueues forwards.
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
  for redirects; for inline forwards a rare duplicate on a record is accepted.
- Schema is additive (two nullable columns, one enum, one enum value): old code ignores it.

## Verification

- E2E (`apps/mail`, real GreenMail): a send with forwarding on reaches the forwarding address and
  every recipient, and no recipient's copy names it; a received message in a thread you replied in
  is forwarded once, `From:` the mailbox, even when sync runs twice; a newsletter is not
  forwarded under `conversations`; history import forwards nothing.
- E2E (`apps/worker`): only the mailbox owner can read or change the setting.
- Live (approved Nov 14, 2026): one send and one received reply from a test
  mailbox to your Attio forwarding address, then check both appear on the right Attio record. This
  picks redirect or inline forward (decision 4).
