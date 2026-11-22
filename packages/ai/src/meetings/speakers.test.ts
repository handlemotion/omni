import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchPerson, resolveSpeakers, speakerTitles } from "./speakers.ts";
import { joinParts, meetingTime, restoreTimes } from "./timeline.ts";
import { fromAssemblyAI } from "./transcript.ts";

const fixture = (name: string) =>
  fromAssemblyAI(
    JSON.parse(
      readFileSync(new URL(`../../../../fixtures/meetings/${name}`, import.meta.url), "utf8"),
    ),
  );

const recorder = { address: "dana@studio.test", name: "Dana Ruiz" };
const marta = { address: "marta@client.test", name: "Marta Gil" };

describe("resolveSpeakers", () => {
  const call = fixture("assemblyai-two-person.json");
  const micA = call.turns.filter((t) => t.speaker === "A");

  it("names the recorder from their mic and the one other attendee of a two-person call", () => {
    const speakers = resolveSpeakers({
      turns: call.turns,
      micSpans: micA,
      recorder,
      attendees: [recorder, marta],
      engineNames: {},
    });
    expect(speakers).toEqual([
      expect.objectContaining({ label: "A", address: recorder.address, source: "mic" }),
      expect.objectContaining({ label: "B", address: marta.address, source: "mic" }),
    ]);
  });

  it("does not name the recorder when the mic mostly carried someone else (speaker bleed)", () => {
    const speakers = resolveSpeakers({
      turns: call.turns,
      micSpans: [{ startMs: 0, endMs: 8000 }],
      recorder,
      attendees: [recorder, marta],
      engineNames: {},
    });
    expect(speakers.every((s) => s.source === null)).toBe(true);
  });

  it("names nobody from the mic in a room, where every speaker is on it", () => {
    const speakers = resolveSpeakers({
      turns: call.turns,
      micSpans: [{ startMs: 0, endMs: call.durationMs }],
      recorder,
      attendees: [recorder, marta],
      engineNames: {},
    });
    expect(speakers.every((s) => s.source === null)).toBe(true);
  });

  it("names nobody without mic spans, as from a browser that could not tell", () => {
    const speakers = resolveSpeakers({
      turns: call.turns,
      micSpans: null,
      recorder,
      attendees: [recorder, marta],
      engineNames: {},
    });
    expect(speakerTitles(speakers)).toEqual(
      new Map([
        ["A", "Speaker 1"],
        ["B", "Speaker 2"],
      ]),
    );
  });

  describe("with the engine's names", () => {
    const kickoff = fixture("assemblyai-named.json");
    const jose = { address: "jose@studio.test", name: "José Ortega" };
    const priya = { address: "priya@studio.test", name: "Priya Nair" };
    const input = {
      turns: kickoff.turns,
      micSpans: kickoff.turns.filter((t) => t.speaker === "A"),
      recorder,
      attendees: [recorder, jose, priya],
      engineNames: kickoff.engineNames,
    };

    it("matches an engine name to its attendee despite a missing accent", () => {
      const speakers = resolveSpeakers(input);
      expect(speakers.find((s) => s.label === "C")).toMatchObject({
        address: jose.address,
        name: "José Ortega",
        source: "engine",
      });
      expect(speakers.find((s) => s.label === "Priya Nair")?.address).toBe(priya.address);
    });

    it("keeps the mic's answer when the engine gives the recorder's label another name", () => {
      const speakers = resolveSpeakers({
        ...input,
        engineNames: { ...input.engineNames, A: "Priya Nair" },
      });
      expect(speakers.find((s) => s.label === "A")).toMatchObject({
        address: recorder.address,
        source: "mic",
      });
    });

    it("never gives two labels the same person", () => {
      const speakers = resolveSpeakers({
        ...input,
        engineNames: { C: "Jose Ortega", "Priya Nair": "Jose Ortega" },
      });
      const joses = speakers.filter((s) => s.address === jose.address);
      expect(joses).toHaveLength(1);
    });

    it("keeps an engine name nobody was invited under, without an address", () => {
      const speakers = resolveSpeakers({ ...input, attendees: [recorder] });
      expect(speakers.find((s) => s.label === "C")).toMatchObject({
        name: "Jose Ortega",
        address: null,
      });
    });
  });
});

describe("matchPerson", () => {
  const people = [
    { address: "ana.lopez@x.test", name: "Ana López" },
    { address: "ana.perez@x.test", name: "Ana Pérez" },
    { address: "luis@x.test", name: "Luis Mora" },
  ];

  it("never swaps a full name for an attendee who only shares the first name", () => {
    expect(
      matchPerson("Ana García", [{ address: "ana.lopez@x.test", name: "Ana López" }]),
    ).toBeNull();
    expect(matchPerson("Luis Ortega", people)).toBeNull();
  });

  it("matches a unique first name, but not one two attendees share", () => {
    expect(matchPerson("Luis", people)?.address).toBe("luis@x.test");
    expect(matchPerson("Ana", people)).toBeNull();
    expect(matchPerson("ana lopez", people)?.address).toBe("ana.lopez@x.test");
  });
});

describe("timeline", () => {
  it("puts audio times back on the meeting's clock after dropped silences", () => {
    const cuts = [
      { atMs: 0, droppedMs: 120_000 },
      { atMs: 600_000, droppedMs: 300_000 },
    ];
    expect(meetingTime(1_000, cuts)).toBe(121_000);
    expect(meetingTime(700_000, cuts)).toBe(1_120_000);
    expect(restoreTimes([{ startMs: 10, endMs: 20 }], [])).toEqual([{ startMs: 10, endMs: 20 }]);
  });

  it("joins a meeting's parts on its clock without mixing their engines' labels", () => {
    const joined = joinParts([
      {
        startMs: 1_800_000,
        transcript: {
          language: "en",
          durationMs: 60_000,
          turns: [{ speaker: "A", startMs: 0, endMs: 5000, text: "Picking up." }],
          engineNames: { A: "Luis Mora" },
        },
      },
      {
        startMs: 0,
        transcript: {
          language: "en",
          durationMs: 1_700_000,
          turns: [{ speaker: "A", startMs: 1000, endMs: 2000, text: "Start." }],
          engineNames: {},
        },
      },
    ]);
    expect(joined.turns).toEqual([
      { speaker: "A", startMs: 1000, endMs: 2000, text: "Start." },
      { speaker: "2:A", startMs: 1_800_000, endMs: 1_805_000, text: "Picking up." },
    ]);
    expect(joined.engineNames).toEqual({ "2:A": "Luis Mora" });
    expect(joined.durationMs).toBe(1_860_000);
  });
});
