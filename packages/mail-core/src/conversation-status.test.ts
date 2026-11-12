import { describe, expect, test } from "vitest";
import {
  type ConversationEvent,
  type ConversationState,
  nextConversationState,
} from "./conversation-status.ts";

const now = new Date("2026-11-12T12:00:00Z");
const later = new Date("2026-11-13T09:00:00Z");
const earlier = new Date("2026-11-12T11:00:00Z");

const open: ConversationState = { status: "open", snoozedUntil: null, resolvedAt: null };
const pending: ConversationState = { status: "pending", snoozedUntil: null, resolvedAt: null };
const snoozed: ConversationState = { status: "snoozed", snoozedUntil: later, resolvedAt: null };
const resolved: ConversationState = { status: "resolved", snoozedUntil: null, resolvedAt: earlier };

const apply = (state: ConversationState, event: ConversationEvent, at = now) =>
  nextConversationState(state, event, at);

describe("a customer message", () => {
  // Bug: a customer replies to a pending, snoozed or resolved conversation and nobody sees it,
  // because it stays out of the Open view.
  test.each([pending, snoozed, resolved])("reopens a $status conversation", (state) => {
    expect(apply(state, { type: "customer_message" })).toEqual({ state: open, changed: true });
  });

  // Bug: ingest redelivers `message.created` and the second delivery writes a duplicate
  // "reopened" event and notifies the assignee twice.
  test("on an open conversation changes nothing", () => {
    expect(apply(open, { type: "customer_message" })).toEqual({ state: open, changed: false });
  });

  // Bug: an out-of-office or bounce reopens a resolved ticket and restarts its SLA.
  test("that is automated leaves a resolved conversation resolved", () => {
    expect(apply(resolved, { type: "customer_message", automated: true }).changed).toBe(false);
  });
});

describe("an agent reply", () => {
  // Bug: after answering, the conversation stays in Open and counts against the team.
  test("moves an open conversation to pending", () => {
    expect(apply(open, { type: "agent_reply" }).state.status).toBe("pending");
  });

  // Bug: the reply's Sent copy is indexed after the agent hit "send and resolve" (or snoozed),
  // and flips the conversation back to pending.
  test.each([resolved, snoozed])("leaves a $status conversation as it is", (state) => {
    expect(apply(state, { type: "agent_reply" })).toEqual({ state, changed: false });
  });
});

describe("resolve", () => {
  // Bug: a snoozed conversation is resolved but keeps `snoozed_until`, so the snooze cron wakes
  // it into Open later.
  test("clears the snooze and stamps the time", () => {
    expect(apply(snoozed, { type: "resolve" }).state).toEqual({
      status: "resolved",
      snoozedUntil: null,
      resolvedAt: now,
    });
  });

  // Bug: a double click resolves twice and moves `resolved_at`, which skews resolution-time
  // reports.
  test("twice keeps the first resolve time", () => {
    expect(apply(resolved, { type: "resolve" })).toEqual({ state: resolved, changed: false });
  });
});

describe("snooze", () => {
  // Bug: a snooze picked in a stale tab is already past, and the conversation flickers out of
  // Open until the next cron tick.
  test("to a time already past is refused", () => {
    expect(apply(open, { type: "snooze", until: earlier })).toEqual({
      state: open,
      changed: false,
    });
  });

  // Bug: snoozing a resolved conversation keeps `resolved_at`, and reports count it as resolved.
  test("of a resolved conversation clears the resolve time", () => {
    expect(apply(resolved, { type: "snooze", until: later }).state).toEqual(snoozed);
  });
});

describe("snooze expired", () => {
  // Bug: the snooze cron never brings the conversation back.
  test("opens a conversation whose snooze is over", () => {
    expect(apply(snoozed, { type: "snooze_expired" }, later)).toEqual({
      state: open,
      changed: true,
    });
  });

  // Bug: the cron picked the conversation, an agent snoozed it again for longer, and the cron's
  // late write wakes it early.
  test("leaves a conversation snoozed again for later alone", () => {
    expect(apply(snoozed, { type: "snooze_expired" }, now).changed).toBe(false);
  });

  // Bug: a customer reply already reopened it, then a retried cron job writes a second event.
  test.each([open, resolved])("leaves a $status conversation alone", (state) => {
    expect(apply(state, { type: "snooze_expired" }, later).changed).toBe(false);
  });
});

describe("reopen", () => {
  // Bug: reopening keeps `resolved_at`, so the conversation shows as resolved in reports.
  test("clears the resolve time", () => {
    expect(apply(resolved, { type: "reopen" })).toEqual({ state: open, changed: true });
  });
});
