# 0027: Later is a place, not a timer

Date: 2026-11-13 · Status: accepted · Amends: ADR 0007 (decision 4 and the Queue view)

## Context

ADR 0007 gave personal triage a **Queue**: `POST /threads/:id/defer { until }` hid a thread
until a time, and it came back to the Inbox by itself when that time passed. The app only ever
offered one time ("Defer a day", `h`), with a picker promised later. A time picker, wake-up
rules and "what happens when a reply arrives while deferred" are machinery nobody asked for.

What people want is simpler: put a thread somewhere that is not the Inbox, and come back to it
when they choose to. Shared inboxes keep their own helpdesk snooze (ADR 0021); that is team
state with a real wake-up time and is not changed here.

## Decision

1. **Later replaces the Queue.** The view is `later` and the page is `/later`, named "Later" in
   the sidebar and search. `/queue` is gone, with no redirect.
2. **Moving to Later has no time.** `POST /threads/:id/later` moves a thread into Later;
   `DELETE /threads/:id/later` moves it back to the Inbox. Neither takes a body. A thread stays
   in Later until the member moves it back or marks it done.
3. **Same column, no migration.** Later reuses `thread_state.snoozed_until`, set to Postgres
   `infinity`. The view rule is unchanged (`snoozed_until > now()`), so rows written by the old
   timed defer still read correctly and run out as they did. Thread rows and the state answer
   expose `later: boolean`. `/counts` reports `later`, not `queue`.
4. **Done and Later still exclude each other**, as in ADR 0007: done clears Later, Later clears
   done.
5. **The app's actions.** The conversation bar shows "Later" (or "Back to inbox"), `h` toggles
   Later on the selected threads, and `g l` opens it.

## Compatibility

Tabs and the previous Worker run next to this one for a while. Until a later PR removes them,
the Worker still accepts `view=queue` (answered as `later`) and the old
`POST /threads/:id/defer { until }` and `DELETE /threads/:id/defer`, and rows still carry
`deferredUntil` (Later's `infinity` reads as 9999-12-31, so old tabs show it as deferred). The old Worker reads
`infinity` as "deferred", so it shows Later threads in its Queue. Remove the aliases once no
client sends them.

## Consequences

- A thread in Later never comes back on its own, including when someone replies. If that turns
  out to bury replies, the fix is a reply bringing the thread back to the Inbox, not a timer.
- The column name `snoozed_until` no longer says what it holds. Renaming it is destructive and
  waits until nothing reads the old shape.
