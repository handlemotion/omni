import { describe, expect, it } from "vitest";
import {
  decide,
  decideSent,
  SENT_TABLE,
  TRIAGE_TABLE,
  type Judgments,
  type SentJudgments,
} from "./decide.ts";
import { laneFor } from "./policy.ts";
import { JUDGMENTS, SENT_JUDGMENTS } from "./questions.ts";

const person: Judgments = {
  expects_reply: 0.05,
  automated: 0.05,
  bulk: 0.05,
  promises_follow_up: 0.05,
  concerns_reader: 0.9,
};

function lane(judgments: Judgments) {
  return laneFor({ ...decide(judgments), source: "ai" });
}

describe("triage truth table", () => {
  it("gives every settled combination of judgments a row of its own", () => {
    for (let mask = 0; mask < 2 ** JUDGMENTS.length; mask++) {
      const judgments = Object.fromEntries(
        JUDGMENTS.map((j, i) => [j, mask & (1 << i) ? 0.95 : 0.05]),
      ) as Judgments;
      const { row, bucket } = decide(judgments);
      expect({ judgments, row }).not.toMatchObject({ row: "unsettled" });
      expect(TRIAGE_TABLE[row as number]?.bucket).toBe(bucket);
    }
  });

  it.each([
    ["a person asking for something", { expects_reply: 0.95 }, "needs_reply"],
    [
      "a person promising to get back",
      { promises_follow_up: 0.95, concerns_reader: 0.9 },
      "waiting_on_them",
    ],
    ["a person just informing", {}, "fyi"],
    ["a receipt for the reader", { automated: 0.95, concerns_reader: 0.95 }, "fyi"],
    ["a promotion", { bulk: 0.95, automated: 0.9, concerns_reader: 0.05 }, "noise"],
    [
      "a promotion that asks for a reply",
      { bulk: 0.95, expects_reply: 0.9, concerns_reader: 0.05 },
      "noise",
    ],
  ] as const)("files %s", (_, overrides, bucket) => {
    expect(lane({ ...person, ...overrides })).toBe(bucket);
  });

  it("sends a deciding judgment between the bands to Unsure, with a best guess", () => {
    const decision = decide({ ...person, expects_reply: 0.6 });
    expect(decision.row).toBe("unsettled");
    expect(decision.bucket).toBe("needs_reply");
    expect(lane({ ...person, expects_reply: 0.6 })).toBe("unsure");
    expect(lane({ ...person, expects_reply: 0.31 })).toBe("unsure");
  });

  it("ignores an unsettled judgment the deciding row doesn't depend on", () => {
    expect(lane({ ...person, bulk: 0.97, concerns_reader: 0.03, expects_reply: 0.5 })).toBe(
      "noise",
    );
  });

  it("takes the weakest deciding judgment as the confidence, not the strongest", () => {
    const decision = decide({ ...person, expects_reply: 0.99, bulk: 0.2 });
    expect(decision.bucket).toBe("needs_reply");
    expect(decision.confidence).toBeCloseTo(0.8);
    expect(lane({ ...person, expects_reply: 0.99, bulk: 0.2 })).toBe("unsure");
  });
});

describe("reader-sent truth table", () => {
  const sent = (judgments: SentJudgments) => laneFor({ ...decideSent(judgments), source: "ai" });
  const closer: SentJudgments = {
    reader_asks_question: 0.03,
    reader_requests_action: 0.04,
    sent_by_system: 0.02,
  };

  it("gives every settled combination a row, and never says needs_reply", () => {
    for (let mask = 0; mask < 2 ** SENT_JUDGMENTS.length; mask++) {
      const judgments = Object.fromEntries(
        SENT_JUDGMENTS.map((j, i) => [j, mask & (1 << i) ? 0.95 : 0.05]),
      ) as SentJudgments;
      const { row, bucket } = decideSent(judgments);
      expect(SENT_TABLE[row as number]?.bucket).toBe(bucket);
      expect(bucket).not.toBe("needs_reply");
    }
  });

  it.each([
    ["a closer that asks nothing", {}, "fyi"],
    ["a question", { reader_asks_question: 0.95 }, "waiting_on_them"],
    ["a request with no question mark", { reader_requests_action: 0.93 }, "waiting_on_them"],
    // Asking either way is enough; the other judgment being unsure doesn't matter.
    [
      "a question beside an unsure request",
      { reader_asks_question: 0.9, reader_requests_action: 0.5 },
      "waiting_on_them",
    ],
    ["an unsure ask", { reader_asks_question: 0.55 }, "unsure"],
    ["a sign-in link an app sent", { reader_requests_action: 0.95, sent_by_system: 0.97 }, "fyi"],
    [
      "an ask that may be app-sent",
      { reader_requests_action: 0.95, sent_by_system: 0.5 },
      "unsure",
    ],
  ] as const)("files %s", (_, overrides, lane) => {
    expect(sent({ ...closer, ...overrides })).toBe(lane);
  });

  it("files a closer only as surely as its least-sure 'no'", () => {
    expect(
      decideSent({ reader_asks_question: 0.02, reader_requests_action: 0.2, sent_by_system: 0.01 })
        .confidence,
    ).toBeCloseTo(0.8);
  });
});
