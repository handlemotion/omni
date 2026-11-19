# 0052: Triage files mail in three lanes; what was FYI gets no lane

Date: 2026-11-19 · Status: accepted · Amends: spec v1 "Triage" (output), ADR 0002, ADR 0007
(reply lanes judge both directions)

## Context

Triage sorted every thread into four buckets: `needs_reply`, `waiting_on_them`, `fyi` and
`noise`. `fyi` collected everything that asks nothing of the reader: receipts, shipping and
account notices, a colleague's heads-up, and every closer the reader sent ("thanks!", "sounds
good", a sign-in link an app sent from their address). None of it asks for action, so it does
not need a lane of its own; the reply lanes and Noise are what triage is for.

## Decision

1. **Three lanes.** Triage files received and sent mail into `needs_reply`, `waiting_on_them` or
   `noise`. `BUCKETS` in `@omni/ai` holds those three.
2. **What used to be FYI gets no lane.** `TriageResult.bucket` is `Bucket | null`; `null` means
   the thread was triaged and belongs in no lane. That covers the rows of the truth tables that
   answered `fyi` (mail that concerns the reader but asks nothing, and a reader message that asks
   nothing or was sent by software), the wordless-reply rule (`triageByRule`), and Claude's
   refusal or invalid-output fallback (still confidence 0, so Unsure). Claude answers `none` for
   such a thread; the code maps it to `null`. `concerns_reader` stays: it is what tells no lane
   from `noise`.
3. **Stored as `threads.triage = null`, still marked triaged.** `saveTriage` accepts a null bucket
   and writes `triage_message_id`, confidence and source as before, so the AI job finishes
   (`triaged`, then `done_already` on redelivery) instead of being read as `no_model`. The Unsure
   lane is unchanged: an AI result below the auto-file threshold is Unsure whatever its bucket.
4. **Helpdesk.** A shared-inbox message with no lane is `low` priority and assigned to nobody, as
   `fyi` was.

## Not changed yet (expand, then contract)

The `fyi` value stays in the `triage_bucket` enum, in the `/counts` keys, the API's lane filter,
MCP schemas and the clients, and a person can still re-sort into it. Existing rows with
`triage = 'fyi'` stay as they are. A later contract step drops the enum value, the old rows and
every client reference once nothing in production writes or reads them.
