import { describe, expect, it } from "vitest";
import {
  createJevClient,
  decidePriority,
  jevTriageRequest,
  pickAssignee,
  pickTags,
  triage,
  type PriorityJudgments,
  type TriageInput,
} from "./index.ts";
import { PRIORITY_JUDGMENTS } from "./questions.ts";

const calm: PriorityJudgments = {
  sender_blocked: 0.05,
  time_sensitive: 0.05,
  money_at_stake: 0.05,
  sender_upset: 0.05,
};

describe("assignee", () => {
  const team = [
    { id: "ana", role: "Billing and refunds" },
    { id: "bo", role: "Bug reports" },
  ];
  it.each([
    ["the one whose role reads yes", [0.1, 0.9], "needs_reply", "bo"],
    ["the most likely of two yeses", [0.95, 0.8], "needs_reply", "ana"],
    ["nobody when no role is a settled yes", [0.6, 0.5], "needs_reply", null],
    ["nobody when the message waits on no one", [0.95, 0.1], "fyi", null],
    ["nobody for noise", [0.95, 0.1], "noise", null],
  ] as const)("picks %s", (_, nouls, bucket, expected) => {
    expect(pickAssignee(team, nouls, bucket)).toBe(expected);
  });
});

describe("priority table", () => {
  it.each([
    ["a plain question", {}, "needs_reply", "normal"],
    [
      "a customer locked out before a launch",
      { sender_blocked: 0.9, time_sensitive: 0.9 },
      "needs_reply",
      "urgent",
    ],
    ["a double charge", { money_at_stake: 0.9 }, "needs_reply", "high"],
    ["an angry follow-up", { sender_upset: 0.9 }, "needs_reply", "high"],
    [
      "a promotion that claims urgency",
      { sender_blocked: 0.9, time_sensitive: 0.95 },
      "noise",
      "low",
    ],
    ["a thank-you that asks nothing", { sender_upset: 0.8 }, "fyi", "low"],
  ] as const)("gives %s %s", (_, overrides, bucket, priority) => {
    expect(decidePriority({ ...calm, ...overrides }, bucket)).toBe(priority);
  });

  it("does not raise priority on a judgment between the bands", () => {
    expect(
      decidePriority({ ...calm, sender_blocked: 0.6, time_sensitive: 0.65 }, "needs_reply"),
    ).toBe("normal");
  });
});

describe("pickTags", () => {
  const tags = ["billing", "bug", "refund", "shipping", "vip"].map((name) => ({ id: name, name }));

  it("keeps settled yeses only, most likely first, at most three", () => {
    expect(pickTags(tags, [0.75, 0.2, 0.95, 0.9, 0.8])).toEqual(["refund", "shipping", "vip"]);
    expect(pickTags(tags, [0.69, 0.5, 0.1, 0.3, 0.6])).toEqual([]);
  });
});

describe("helpdesk triage on Jev", () => {
  const input: TriageInput = {
    from: { name: "Ana", address: "ana@customer.example" },
    subject: "Charged twice",
    latestText: "You charged my card twice this month. Please refund one of them.",
    latestFromUs: false,
    messageCount: 1,
    repliedBefore: false,
    helpdesk: {
      tags: [
        { id: "tag_bug", name: "Bug" },
        { id: "tag_billing", name: "Billing" },
      ],
    },
  };

  function jevAnswering(answers: Record<string, number>) {
    const sent: unknown[] = [];
    const client = createJevClient({
      apiKey: "test",
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({
          model: "jev-1.14.0",
          answers: Object.fromEntries(
            Object.entries(answers).map(([k, noul]) => [k, { type: "noul", noul }]),
          ),
          usage: { input_tokens: 900, output_tokens: 12 },
        });
      },
    });
    return { client, sent };
  }

  const bucketAnswers = {
    expects_reply: 0.95,
    automated: 0.05,
    bulk: 0.05,
    promises_follow_up: 0.05,
    concerns_reader: 0.9,
  };

  it("asks priority and tag questions in the triage request and maps tags back by position", async () => {
    const { client, sent } = jevAnswering({
      ...bucketAnswers,
      ...Object.fromEntries(PRIORITY_JUDGMENTS.map((j) => [j, 0.05])),
      money_at_stake: 0.92,
      tag_0: 0.1,
      tag_1: 0.93,
    });
    const result = await triage(client, input);
    expect(result.bucket).toBe("needs_reply");
    expect(result.helpdesk).toEqual({
      priority: "high",
      tagIds: ["tag_billing"],
      assigneeId: null,
    });
    const questions = (sent[0] as { questions: Record<string, { instructions: string }> })
      .questions;
    expect(questions.tag_1?.instructions).toContain('"Billing"');
  });

  it("throws rather than guessing when a tag answer is missing, so the queue retries", async () => {
    const { client } = jevAnswering({
      ...bucketAnswers,
      ...Object.fromEntries(PRIORITY_JUDGMENTS.map((j) => [j, 0.05])),
      tag_0: 0.1,
    });
    await expect(triage(client, input)).rejects.toThrow(/tag_1/);
  });

  it("asks only the sent questions when the team wrote last", () => {
    const request = jevTriageRequest({ ...input, latestFromUs: true });
    expect(Object.keys(request.questions)).not.toContain("tag_0");
    expect(Object.keys(request.questions)).not.toContain("sender_blocked");
  });
});
