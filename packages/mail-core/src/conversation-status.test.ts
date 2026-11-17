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
  test.each([pending, snoozed, resolved])("reopens a $status conversation", (state) => {
    expect(apply(state, { type: "customer_message" })).toEqual({ state: open, changed: true });
  });

  test("on an open conversation changes nothing", () => {
    expect(apply(open, { type: "customer_message" })).toEqual({ state: open, changed: false });
  });

  test("that is automated leaves a resolved conversation resolved", () => {
    expect(apply(resolved, { type: "customer_message", automated: true }).changed).toBe(false);
  });
});

describe("an agent reply", () => {
  test("moves an open conversation to pending", () => {
    expect(apply(open, { type: "agent_reply" }).state.status).toBe("pending");
  });

  test.each([resolved, snoozed])("leaves a $status conversation as it is", (state) => {
    expect(apply(state, { type: "agent_reply" })).toEqual({ state, changed: false });
  });
});

describe("resolve", () => {
  test("clears the snooze and stamps the time", () => {
    expect(apply(snoozed, { type: "resolve" }).state).toEqual({
      status: "resolved",
      snoozedUntil: null,
      resolvedAt: now,
    });
  });

  test("twice keeps the first resolve time", () => {
    expect(apply(resolved, { type: "resolve" })).toEqual({ state: resolved, changed: false });
  });
});

describe("snooze", () => {
  test("to a time already past is refused", () => {
    expect(apply(open, { type: "snooze", until: earlier })).toEqual({
      state: open,
      changed: false,
    });
  });

  test("of a resolved conversation clears the resolve time", () => {
    expect(apply(resolved, { type: "snooze", until: later }).state).toEqual(snoozed);
  });
});

describe("snooze expired", () => {
  test("opens a conversation whose snooze is over", () => {
    expect(apply(snoozed, { type: "snooze_expired" }, later)).toEqual({
      state: open,
      changed: true,
    });
  });

  test("leaves a conversation snoozed again for later alone", () => {
    expect(apply(snoozed, { type: "snooze_expired" }, now).changed).toBe(false);
  });

  test.each([open, resolved])("leaves a $status conversation alone", (state) => {
    expect(apply(state, { type: "snooze_expired" }, later).changed).toBe(false);
  });
});

describe("reopen", () => {
  test("clears the resolve time", () => {
    expect(apply(resolved, { type: "reopen" })).toEqual({ state: open, changed: true });
  });
});
