import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  askScenarios,
  groupScenarios,
  meetingsRecordingUrl,
} from "../../eval/meetings-scenarios.ts";
import {
  ASK_TRANSCRIPT_CHARS,
  askMeetings,
  askPrompt,
  cleanAnswer,
  type AskMeeting,
} from "./ask.ts";
import { GROUP_MAX_MEETINGS, groupPrompt, summarizeGroup } from "./group.ts";

const recording = (id: string) =>
  JSON.parse(readFileSync(meetingsRecordingUrl(id), "utf8")) as {
    user: string;
    response: Anthropic.Message;
  };

const replaying = (response: Anthropic.Message) =>
  ({
    messages: { create: async () => response },
  }) as unknown as Parameters<typeof askMeetings>[0];

describe.each(groupScenarios)("$id", ({ id, meetings, holds }) => {
  const { user, response } = recording(id);

  it("still sends the prompt the summary was recorded for", () => {
    expect(groupPrompt(meetings)).toBe(user);
  });

  it("summarizes where the group stands", async () => {
    const { summary } = await summarizeGroup(replaying(response), meetings);
    for (const word of holds) expect(summary?.toLowerCase()).toContain(word);
  });
});

describe.each(askScenarios)("$id", ({ id, question, meetings, holds }) => {
  const { user, response } = recording(id);

  it("still sends the prompt the answer was recorded for", () => {
    expect(askPrompt(question, meetings)).toBe(user);
  });

  it("answers with citations to a meeting it was given", async () => {
    const result = await askMeetings(replaying(response), question, meetings);
    if (!result.ok) throw new Error(result.reason);
    for (const word of holds.words) expect(result.answer.toLowerCase()).toContain(word);
    expect(result.citations.map((c) => c.meetingId)).toContain(holds.citesMeeting);
    for (const c of result.citations) expect(result.answer).toContain(`[${c.n}]`);
  });
});

const meeting = (id: string, durationMs: number | null) =>
  ({
    id,
    title: id,
    startedAt: new Date("2026-11-20T10:00:00Z"),
    durationMs,
    summary: null,
    highlights: [],
    transcript: null,
  }) satisfies AskMeeting as AskMeeting;

describe("cleanAnswer", () => {
  const given = [meeting("a", 60_000), meeting("b", null)];

  it("drops a citation to a meeting it was not given, and its marker", () => {
    const cleaned = cleanAnswer(
      {
        answer: "Yes [1], and also [2].",
        citations: [
          { meeting: 3, at: "00:10" },
          { meeting: 2, at: "00:10" },
        ],
      },
      given,
    );
    expect(cleaned.citations).toEqual([{ n: 1, meetingId: "b", atMs: 10_000 }]);
    expect(cleaned.answer).toBe("Yes, and also [1].");
  });

  it("drops a time past the meeting's end, or one that is not a time", () => {
    const cleaned = cleanAnswer(
      {
        answer: "[1] [2] [3]",
        citations: [
          { meeting: 1, at: "02:00" },
          { meeting: 1, at: "soon" },
          { meeting: 1, at: "00:59" },
        ],
      },
      given,
    );
    expect(cleaned.citations).toEqual([{ n: 1, meetingId: "a", atMs: 59_000 }]);
    expect(cleaned.answer).toBe("[1]");
  });
});

describe("askPrompt", () => {
  it("reads transcripts only up to its budget, the first meetings first", () => {
    const long = "word ".repeat(ASK_TRANSCRIPT_CHARS / 5);
    const turns = [{ speaker: "A", startMs: 0, endMs: 1_000, text: long }];
    const titles = new Map([["A", "Ana"]]);
    const prompt = askPrompt("q", [
      { ...meeting("a", null), transcript: { turns, titles } },
      { ...meeting("b", null), transcript: { turns, titles } },
    ]);
    expect(prompt.split("Transcript:")).toHaveLength(2);
    expect(prompt.length).toBeLessThan(ASK_TRANSCRIPT_CHARS + 1_000);
  });
});

describe("groupPrompt", () => {
  it("reads at most the newest twelve meetings", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `m${i}`,
      startedAt: new Date(Date.UTC(2026, 0, 20 - i)),
      summary: "s",
      highlights: [],
    }));
    const prompt = groupPrompt(many);
    expect(prompt.match(/^## /gm)).toHaveLength(GROUP_MAX_MEETINGS);
    expect(prompt).not.toContain("m12");
  });
});
