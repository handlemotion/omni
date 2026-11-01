import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseMessage } from "./parse";
import {
  addedRecipients,
  decideThread,
  normalizeSubject,
  participants,
  type ThreadCandidate,
} from "./thread";

const parse = async (name: string) =>
  (await parseMessage(readFileSync(new URL(`../../../fixtures/eml/${name}`, import.meta.url))))
    .message;

const SELF = ["sam@example.com", "hello@example.com"];
const DAY = 24 * 60 * 60 * 1000;

const deployThread = (overrides: Partial<ThreadCandidate>): ThreadCandidate => ({
  threadId: "t-deploy",
  subjectKey: "deploy window",
  participants: ["hello@example.com", "ops@fundacionsol.example.org"],
  lastMessageAt: new Date("2026-10-15T07:00:00Z"),
  ...overrides,
});
const decide = async (candidates: ThreadCandidate[]) =>
  decideThread(await parse("no-message-id.eml"), {
    knownMessageIds: new Map(),
    candidates,
    selfAddresses: SELF,
  });

describe("normalizeSubject", () => {
  test.each([
    ["Re: Brand review", "brand review"],
    ["RE: AW: Fwd: Brand review", "brand review"],
    ["Re[2]: SV:  Brand   review ", "brand review"],
    ["FW: TR: RV: Enc: WG: Antw: Brand review", "brand review"],
    ["Re：Brand review", "brand review"],
    ["Re: Re:", ""],
    // Words that only start like a prefix are part of the subject.
    ["Regarding: the plan", "regarding: the plan"],
    ["Resume: Ana Pérez", "resume: ana pérez"],
  ])("%j → %j", (subject, expected) => {
    expect(normalizeSubject(subject)).toBe(expected);
  });
});

describe("decideThread", () => {
  test("joins by In-Reply-To", async () => {
    const message = await parse("gmail-reply.eml");
    const knownMessageIds = new Map([["<CAF3kq1x8Yd0Zr2@mail.example.com>", "t-brand"]]);
    expect(decideThread(message, { knownMessageIds, candidates: [], selfAddresses: SELF })).toEqual(
      {
        kind: "headers",
        threadId: "t-brand",
      },
    );
  });

  test("falls back to References when the direct parent was never synced", async () => {
    // In-Reply-To names a message sent from another device that we have not stored.
    const message = await parse("apple-mail-reply.eml");
    const knownMessageIds = new Map([
      ["<CAGm7xR2pQw9LkV4n+YtE5uB1aD@mail.gmail.example.com>", "t-brand"],
    ]);
    expect(decideThread(message, { knownMessageIds, candidates: [], selfAddresses: SELF })).toEqual(
      {
        kind: "headers",
        threadId: "t-brand",
      },
    );
  });

  test("a reply to an unknown message starts a thread even when the subject matches", async () => {
    const message = await parse("outlook-desktop-reply.eml");
    const candidate: ThreadCandidate = {
      threadId: "t-other-contract",
      subjectKey: "contract draft v3",
      participants: ["luis.romero@acmelegal.example.net"],
      lastMessageAt: new Date("2026-10-28T17:00:00Z"),
    };
    expect(
      decideThread(message, {
        knownMessageIds: new Map(),
        candidates: [candidate],
        selfAddresses: SELF,
      }),
    ).toEqual({ kind: "new", subjectKey: "contract draft v3" });
  });

  describe("by subject, for mail without reply headers", () => {
    test("joins a recent thread with the same people", async () => {
      expect(await decide([deployThread({})])).toEqual({ kind: "subject", threadId: "t-deploy" });
    });

    test("prefers the most recent of several matching threads", async () => {
      const older = deployThread({
        threadId: "t-older",
        lastMessageAt: new Date("2026-10-01T07:00:00Z"),
      });
      expect(await decide([older, deployThread({})])).toEqual({
        kind: "subject",
        threadId: "t-deploy",
      });
    });

    test("our own address on both sides is not an overlap", async () => {
      const strangers = deployThread({
        participants: ["hello@example.com", "ci@elsewhere.example.net"],
      });
      expect(await decide([strangers])).toEqual({ kind: "new", subjectKey: "deploy window" });
    });

    test("does not join a thread quiet for more than 30 days", async () => {
      const stale = deployThread({
        lastMessageAt: new Date(Date.parse("2026-10-21T07:30:00Z") - 31 * DAY),
      });
      expect(await decide([stale])).toEqual({ kind: "new", subjectKey: "deploy window" });
    });
  });

  test("an empty subject never matches by subject", async () => {
    const message = { ...(await parse("no-message-id.eml")), subject: "Re:" };
    const candidate: ThreadCandidate = {
      threadId: "t-blank",
      subjectKey: "",
      participants: ["ops@fundacionsol.example.org"],
      lastMessageAt: new Date("2026-10-20T07:00:00Z"),
    };
    expect(
      decideThread(message, {
        knownMessageIds: new Map(),
        candidates: [candidate],
        selfAddresses: SELF,
      }),
    ).toEqual({ kind: "new", subjectKey: "" });
  });
});

test("addedRecipients names who joined mid-thread, ignoring address case", async () => {
  const earlier = participants(await parse("gmail-reply.eml"));
  const reply = await parse("cc-added-mid-thread.eml");
  expect(addedRecipients(reply, earlier)).toEqual([
    { name: "Bea Soto", address: "bea.soto@studionorte.example.org" },
  ]);
  expect(addedRecipients(reply, [...earlier, "BEA.SOTO@studionorte.example.org"])).toEqual([]);
});
