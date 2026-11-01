import { describe, expect, it } from "vitest";
import { decide, TRIAGE_TABLE, type Judgments } from "./decide.ts";
import { laneFor } from "./policy.ts";
import { JUDGMENTS } from "./questions.ts";

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
