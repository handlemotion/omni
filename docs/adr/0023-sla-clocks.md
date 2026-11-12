# 0023: SLA clocks

Date: 2026-11-12 · Status: accepted · Extends ADR 0021

## Context

ADR 0021 gave each shared inbox `sla_policies` (first response, next response and resolution
targets in minutes, per priority) and one `business_hours` row, and gave conversations three due
times that the "SLA at risk" view reads. It left open how the due times are computed, when they
start and stop, and how alerts fire exactly once from a cron that may run late or twice.

Three cases shaped the answer. Triage often raises a conversation's priority seconds after it
arrives, so due times must follow a priority change. A newly connected inbox syncs years of mail,
which must not breach at once. And alerts come from a per-minute cron, which can be late, run
twice, or race a teammate's reply.

## Decision

1. **Two clocks per conversation, due times derived from them.** `threads.response_clock_at` is
   when the customer started waiting for the reply we owe; `threads.resolution_clock_at` is when
   the current open stretch began. The three due times are always recomputed from the clocks, the
   priority's targets and the business hours (`setSlaClocks` in `packages/db/src/sla.ts`). A
   priority change, or a change to an inbox's targets or hours, recomputes them with the same
   clocks, so the new targets apply from when the customer actually wrote.
2. **Start and stop.**
   - A customer's message starts the response clock if it is not running, and the resolution
     clock likewise, at the message's sent time (never later than now). Automated mail
     (bounces, auto-replies) starts nothing.
   - Mail sent before the inbox was connected (`mailboxes.created_at`) starts nothing, so a first
     sync does not breach every old conversation.
   - Our reply (sent from Omni or indexed from Sent) stops the response clock. Before the first
     reply the running target is first response; after it, next response.
   - Resolve stops both clocks. A manual reopen starts none: nobody wrote.
   - Snooze and pending do not pause the clocks. Alerts fire only while a conversation is open,
     so a snoozed conversation alerts when it wakes if it is still late.
3. **Business hours.** With `business_hours_only`, a target counts only minutes inside the
   inbox's weekly windows, in its IANA zone, skipping holidays (`addBusinessMinutes` in
   `@omni/mail-core/business-hours`, pure and unit-tested across weekends, DST and split shifts).
   An inbox with no hours row counts every minute.
4. **Alerts once per due time.** The minute cron (`emitSlaAlerts`) looks at open conversations due
   within `SLA_AT_RISK_MINUTES` (30) or past due, newest due first, and writes a `sla_at_risk` or
   `sla_breached` event keyed `<kind>:<target>:<due ISO>` in `conversation_events.dedupe_key`,
   after re-checking the row under a lock. A run that finds the key written does nothing. A new
   due time (a new customer message, a priority change) can alert again; the same one cannot. A
   conversation found already past due alerts breached only.
5. **Who hears.** The assignee, or every member who can see the inbox when nobody owns it, gets a
   notification (filtered by their preferences in realtime), and the inbox gets the
   `sla.at_risk` / `sla.breached` realtime event.
6. **Settings.** Org owners and admins set targets (`PUT|DELETE /api/mailboxes/:id/sla/:priority`)
   and hours (`PUT|DELETE /api/mailboxes/:id/business-hours`); everyone who sees the inbox reads
   them (`GET /api/mailboxes/:id/sla`). A change recomputes the due times of the inbox's
   conversations whose clocks are running, compare-and-set against their clocks and priority so
   it never overwrites a newer change.

## Consequences

- One additive migration (two nullable columns). Conversations from before it have no clocks
  until their customer writes again.
- Resolution time is wall time from the first message of an open stretch, not paused while
  pending. A team that wants "time waiting on us" reads it from the event log (reports, B7).
- A thread merge (mail service, A8) takes the earliest of each clock.
