// The helpdesk's status rules (ADR 0021) in one place. The Worker applies them on ingest, on an
// agent's reply and on every explicit action; the SLA and snooze crons apply them too. Every
// caller may run twice (at-least-once delivery, a retried job), so each transition is idempotent:
// applying the same event to its own result changes nothing.

export type ConversationStatus = "open" | "pending" | "snoozed" | "resolved";

export interface ConversationState {
  status: ConversationStatus;
  /** Set exactly while `status` is `snoozed`. */
  snoozedUntil: Date | null;
  /** Set exactly while `status` is `resolved`. */
  resolvedAt: Date | null;
}

export type ConversationEvent =
  /**
   * A message from the customer was indexed. `automated` (auto-reply, out of office, bounce) never
   * reopens: it would undo a resolve and restart an SLA on mail nobody needs to answer.
   */
  | { type: "customer_message"; automated?: boolean }
  /** A teammate's reply was sent, or its copy was indexed from Sent. */
  | { type: "agent_reply" }
  | { type: "resolve" }
  | { type: "snooze"; until: Date }
  /** The snooze cron found `snoozed_until` passed. */
  | { type: "snooze_expired" }
  | { type: "reopen" };

export interface ConversationTransition {
  state: ConversationState;
  /** False when the event leaves the conversation as it was: write no event row, notify no one. */
  changed: boolean;
}

const open: ConversationState = { status: "open", snoozedUntil: null, resolvedAt: null };

/** The conversation's state after `event` happens at `now`. Pure; never throws. */
export function nextConversationState(
  state: ConversationState,
  event: ConversationEvent,
  now: Date,
): ConversationTransition {
  switch (event.type) {
    case "customer_message":
      // The customer wrote: whatever we were waiting for, the team owes a reply now.
      return event.automated ? same(state) : to(state, open);
    case "agent_reply":
      // Only an open conversation becomes pending. A reply's Sent copy can be indexed after a
      // teammate snoozed or resolved the conversation, and must not undo that.
      return state.status === "open" ? to(state, { ...open, status: "pending" }) : same(state);
    case "resolve":
      return state.status === "resolved"
        ? same(state)
        : to(state, { status: "resolved", snoozedUntil: null, resolvedAt: now });
    case "snooze":
      // A time already past would snooze until the next cron tick wakes it: refuse it.
      if (event.until.getTime() <= now.getTime()) return same(state);
      return to(state, { status: "snoozed", snoozedUntil: event.until, resolvedAt: null });
    case "snooze_expired":
      // The cron can run late or twice, and the conversation may have been snoozed again for
      // longer since it was picked: wake it only if its current snooze is really over.
      return state.status === "snoozed" &&
        state.snoozedUntil !== null &&
        state.snoozedUntil.getTime() <= now.getTime()
        ? to(state, open)
        : same(state);
    case "reopen":
      return to(state, open);
  }
}

function same(state: ConversationState): ConversationTransition {
  return { state, changed: false };
}

function to(state: ConversationState, next: ConversationState): ConversationTransition {
  const changed =
    state.status !== next.status ||
    state.snoozedUntil?.getTime() !== next.snoozedUntil?.getTime() ||
    state.resolvedAt?.getTime() !== next.resolvedAt?.getTime();
  return changed ? { state: next, changed } : same(state);
}
