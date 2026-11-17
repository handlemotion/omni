export type ConversationStatus = "open" | "pending" | "snoozed" | "resolved";

export interface ConversationState {
  status: ConversationStatus;
  /** Set exactly while `status` is `snoozed`. */
  snoozedUntil: Date | null;
  /** Set exactly while `status` is `resolved`. */
  resolvedAt: Date | null;
}

export type ConversationEvent =
  | { type: "customer_message"; automated?: boolean }
  | { type: "agent_reply" }
  | { type: "resolve" }
  | { type: "snooze"; until: Date }
  | { type: "snooze_expired" }
  | { type: "reopen" };

export interface ConversationTransition {
  state: ConversationState;
  /** False when the event leaves the conversation as it was: write no event row, notify no one. */
  changed: boolean;
}

const open: ConversationState = { status: "open", snoozedUntil: null, resolvedAt: null };

/** The conversation's state after `event` happens at `now`. Pure; never throws. */
export const nextConversationState: (
  state: ConversationState,
  event: ConversationEvent,
  now: Date,
) => ConversationTransition = (state, event, now) => {
  switch (event.type) {
    case "customer_message":
      return event.automated ? same(state) : to(state, open);
    case "agent_reply":
      return state.status === "open" ? to(state, { ...open, status: "pending" }) : same(state);
    case "resolve":
      return state.status === "resolved"
        ? same(state)
        : to(state, { status: "resolved", snoozedUntil: null, resolvedAt: now });
    case "snooze":
      if (event.until.getTime() <= now.getTime()) return same(state);
      return to(state, { status: "snoozed", snoozedUntil: event.until, resolvedAt: null });
    case "snooze_expired":
      return state.status === "snoozed" &&
        state.snoozedUntil !== null &&
        state.snoozedUntil.getTime() <= now.getTime()
        ? to(state, open)
        : same(state);
    case "reopen":
      return to(state, open);
  }
};

const same: (state: ConversationState) => ConversationTransition = (state) => {
  return { state, changed: false };
};

function to(state: ConversationState, next: ConversationState) {
  const changed =
    state.status !== next.status ||
    state.snoozedUntil?.getTime() !== next.snoozedUntil?.getTime() ||
    state.resolvedAt?.getTime() !== next.resolvedAt?.getTime();
  return (changed ? { state: next, changed } : same(state)) satisfies ConversationTransition;
}
