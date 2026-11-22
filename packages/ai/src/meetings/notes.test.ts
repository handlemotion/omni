import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  meetingsRecordingUrl,
  namingScenarios,
  notesScenarios,
} from "../../eval/meetings-scenarios.ts";
import { acceptNames, nameSpeakers, namingPrompt } from "./naming.ts";
import { cleanNotes, notesPrompt, writeNotes, type NotesAnswer } from "./notes.ts";
import { formatClock, parseClock, renderTranscript, splitLines } from "./render.ts";

const recording = (id: string) =>
  JSON.parse(readFileSync(meetingsRecordingUrl(id), "utf8")) as {
    user: string;
    response: Anthropic.Message;
  };

const replaying = (response: Anthropic.Message, users: string[] = []) =>
  ({
    messages: {
      create: async (body: { messages: Array<{ content: string }> }) => {
        users.push(body.messages[0]?.content ?? "");
        return response;
      },
    },
  }) as unknown as Parameters<typeof writeNotes>[0];

describe.each(notesScenarios)("$id", ({ id, input, holds }) => {
  const { user, response } = recording(id);

  it("still sends the prompt the notes were recorded for", () => {
    expect(notesPrompt(input, renderTranscript(input.turns, input.titles))).toBe(user);
  });

  it("writes notes that hold the meeting's facts, with times inside it", async () => {
    const result = await writeNotes(replaying(response), input);
    if (!result.ok) throw new Error(result.reason);
    const { notes } = result;
    const written = [notes.summary, ...notes.highlights.map((h) => h.text)].join(" ").toLowerCase();
    for (const word of holds.summaryWords) expect(written).toContain(word);
    expect(notes.highlights.length).toBeGreaterThan(0);
    for (const h of notes.highlights) expect(h.atMs).toBeLessThanOrEqual(input.durationMs);
    const tasks = notes.actions.filter((a) => a.kind === "task");
    expect(tasks.some((t) => t.title.toLowerCase().includes(holds.taskWord))).toBe(true);
    const emailTo = notes.actions.flatMap((a) => (a.kind === "email" ? a.to : []));
    expect(holds.emailTo === null || emailTo.includes(holds.emailTo)).toBe(true);
    const newParts = [notes.decisions.length > 0, notes.chapters.length > 0];
    expect(newParts).toEqual(holds.recordedAt >= 2 ? [true, true] : [false, false]);
    for (const m of [...notes.decisions, ...notes.questions]) {
      expect(m.atMs).toBeLessThanOrEqual(input.durationMs);
    }
    expect(JSON.stringify(notes)).not.toMatch(/Speaker \d/);
  });
});

describe.each(namingScenarios)("$id", ({ id, input, expect: wanted }) => {
  const { user, response } = recording(id);

  it("still sends the prompt the names were recorded for", () => {
    expect(namingPrompt(input)).toBe(user);
  });

  it("names the label the transcript shows, with the attendee's address", async () => {
    const { named } = await nameSpeakers(replaying(response), input);
    expect(Object.fromEntries(named.map((s) => [s.label, s.address]))).toEqual(wanted);
    for (const s of named) expect(s.source).toBe("ai");
  });
});

describe("acceptNames", () => {
  const [{ input }] = namingScenarios as [(typeof namingScenarios)[number]];

  it("refuses evidence that is not in the transcript", () => {
    const named = acceptNames(
      { speakers: [{ label: "C", name: "José Ortega", evidence: "Thanks José, great work" }] },
      input,
    );
    expect(named).toEqual([]);
  });

  it("refuses a label that is already named, and a name the evidence does not hold", () => {
    expect(
      acceptNames(
        { speakers: [{ label: "A", name: "José Ortega", evidence: "Jose, can you send" }] },
        input,
      ),
    ).toEqual([]);
    expect(
      acceptNames(
        { speakers: [{ label: "C", name: "Carlos", evidence: "Sure, Thursday works." }] },
        input,
      ),
    ).toEqual([]);
  });

  it("refuses evidence copied from the invite list rather than the transcript", () => {
    const named = acceptNames(
      {
        speakers: [{ label: "C", name: "José Ortega", evidence: "José Ortega <jose@studio.test>" }],
      },
      input,
    );
    expect(named).toEqual([]);
  });
});

describe("cleanNotes", () => {
  const [{ input }] = notesScenarios as [(typeof notesScenarios)[number]];
  const answer: NotesAnswer = {
    title: "Ignored, the event has one",
    summary: " Fine. ",
    highlights: [
      { text: "Inside", at: "00:41" },
      { text: "After the end", at: "59:00" },
      { text: "Not a time", at: "soon" },
    ],
    actions: [
      {
        kind: "task",
        title: " ",
        description: "",
        owner: "",
        due: "",
        to: [],
        subject: "",
        body: "",
      },
      {
        kind: "email",
        title: "",
        description: "",
        owner: "",
        due: "",
        to: ["stranger@else.test"],
        subject: "s",
        body: "b",
      },
      {
        kind: "email",
        title: "",
        description: "",
        owner: "",
        due: "",
        to: ["MARTA@client.test"],
        subject: "One",
        body: "b",
      },
      {
        kind: "email",
        title: "",
        description: "",
        owner: "",
        due: "",
        to: ["marta@client.test"],
        subject: "Two",
        body: "b",
      },
    ],
    decisions: [
      { text: "Ship on the 4th", at: "00:30" },
      { text: "After the end", at: "59:00" },
    ],
    questions: [
      { text: " ", at: "00:10" },
      { text: "Who owns the export?", at: "01:05" },
    ],
    chapters: [
      { title: "Budget", at: "01:00", points: ["18k", " ", "two reviews"] },
      { title: "Intro", at: "00:00", points: ["Hello"] },
      { title: "Later", at: "59:00", points: [] },
      { title: " ", at: "00:20", points: ["no title"] },
    ],
    topics: ["a", " ", "b"],
  };

  it("drops times outside the meeting, mail to people not in it, empty tasks and extra emails", () => {
    const notes = cleanNotes(answer, input);
    expect(notes.title).toBeNull();
    expect(notes.summary).toBe("Fine.");
    expect(notes.highlights).toEqual([{ text: "Inside", atMs: 41_000 }]);
    expect(notes.actions).toEqual([
      { kind: "email", to: ["marta@client.test"], subject: "One", body: "b" },
    ]);
    expect(notes.topics).toEqual(["a", "b"]);
  });

  it("keeps decisions and open questions inside the meeting, and chapters in order", () => {
    const notes = cleanNotes(answer, input);
    expect(notes.decisions).toEqual([{ text: "Ship on the 4th", atMs: 30_000 }]);
    expect(notes.questions).toEqual([{ text: "Who owns the export?", atMs: 65_000 }]);
    expect(notes.chapters).toEqual([
      { title: "Intro", startMs: 0, points: ["Hello"] },
      { title: "Budget", startMs: 60_000, points: ["18k", "two reviews"] },
    ]);
  });

  it("keeps a task's description, and none when it is blank", () => {
    const notes = cleanNotes(
      {
        ...answer,
        actions: [
          {
            kind: "task",
            title: "Send the deck",
            description: " So the client can review it before Friday. ",
            owner: "Dana",
            due: "",
            to: [],
            subject: "",
            body: "",
          },
          {
            kind: "task",
            title: "Book the room",
            description: " ",
            owner: "",
            due: "",
            to: [],
            subject: "",
            body: "",
          },
        ],
      },
      input,
    );
    expect(notes.actions).toEqual([
      {
        kind: "task",
        title: "Send the deck",
        description: "So the client can review it before Friday.",
        owner: "Dana",
        due: null,
      },
      { kind: "task", title: "Book the room", description: null, owner: null, due: null },
    ]);
  });
});

it("writes a long meeting in parts, then together, and adds up what it spent", async () => {
  const [{ input }] = notesScenarios as [(typeof notesScenarios)[number]];
  const { response } = recording("notes-two-person-es");
  const users: string[] = [];
  const result = await writeNotes(replaying(response, users), input, { partChars: 300 });
  expect(users.length).toBeGreaterThan(2);
  expect(users.at(-1)).toContain("Notes of each part");
  expect(
    users.slice(0, -1).every((u) => u.includes(`of ${users.length - 1} of the transcript`)),
  ).toBe(true);
  expect(result.usage.tokensIn).toBe(response.usage.input_tokens * users.length);
});

describe("clock", () => {
  it("formats and parses mm:ss and h:mm:ss, and refuses what is not a time", () => {
    expect(formatClock(61_500)).toBe("01:01");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(parseClock("1:02:03")).toBe(3_723_000);
    expect(parseClock("01:01")).toBe(61_000);
    expect(parseClock("01:75")).toBeNull();
    expect(parseClock("noon")).toBeNull();
  });

  it("splits a transcript between lines, never inside one", () => {
    expect(splitLines("aaaa\nbbbb\ncccc", 9)).toEqual(["aaaa\nbbbb", "cccc"]);
  });
});
