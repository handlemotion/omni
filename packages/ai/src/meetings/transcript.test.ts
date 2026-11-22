import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromAssemblyAI, fromOpenAI, fromWorkersAI, joinTurns } from "./transcript.ts";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../../fixtures/meetings/${name}`, import.meta.url), "utf8"),
  ) as unknown;

describe("fromAssemblyAI", () => {
  it("keeps ms times, turns audio_duration seconds into ms and reads the language code", () => {
    const t = fromAssemblyAI(fixture("assemblyai-two-person.json"));
    expect(t.durationMs).toBe(95_400);
    expect(t.language).toBe("es");
    expect(t.turns[0]).toMatchObject({ speaker: "A", startMs: 1200, endMs: 6800 });
  });

  it("joins one speaker's back-to-back utterances into one turn", () => {
    const t = fromAssemblyAI(fixture("assemblyai-two-person.json"));
    expect(t.turns.map((turn) => turn.speaker)).toEqual(["A", "B", "A", "B", "A", "B"]);
    expect(t.turns[2]?.text).toBe(
      "Ok, yo me encargo del acceso hoy. And for the English copy, we keep the launch date on the twelfth?",
    );
  });

  it("keeps the names speaker identification gave, by mapping and by replaced label", () => {
    const t = fromAssemblyAI(fixture("assemblyai-named.json"));
    expect(t.language).toBe("en");
    expect(t.engineNames).toEqual({ C: "Jose Ortega", "Priya Nair": "Priya Nair" });
    expect(t.turns.map((turn) => turn.speaker)).toEqual(["A", "Priya Nair", "C", "A", "C"]);
  });

  it("reads an empty or failed response as no turns rather than throwing", () => {
    expect(fromAssemblyAI({ status: "error" })).toEqual({
      language: null,
      durationMs: 0,
      turns: [],
      engineNames: {},
    });
  });
});

describe("fromOpenAI", () => {
  it("reads verbose_json seconds into ms, with no speakers, and a Whisper language name", () => {
    const t = fromOpenAI({
      language: "spanish",
      duration: 12.5,
      segments: [
        { start: 0.0, end: 3.2, text: " Hola a todos." },
        { start: 6.0, end: 9.75, text: " Empezamos." },
      ],
    });
    expect(t).toEqual({
      language: "es",
      durationMs: 12_500,
      engineNames: {},
      turns: [
        { speaker: null, startMs: 0, endMs: 3200, text: "Hola a todos." },
        { speaker: null, startMs: 6000, endMs: 9750, text: "Empezamos." },
      ],
    });
  });

  it("keeps a diarized server's speakers and falls back to the last end for the duration", () => {
    const t = fromOpenAI({
      segments: [
        { speaker: "SPEAKER_00", start: 0, end: 2, text: "Hi." },
        { speaker: "SPEAKER_01", start: 2.5, end: 4, text: "Hello." },
      ],
    });
    expect(t.durationMs).toBe(4000);
    expect(t.turns.map((turn) => turn.speaker)).toEqual(["SPEAKER_00", "SPEAKER_01"]);
  });
});

it("fromWorkersAI reads transcription_info and segments with no speakers", () => {
  const t = fromWorkersAI({
    transcription_info: { language: "en", duration: 3.4 },
    segments: [{ start: 0.2, end: 3.1, text: "Quick sync." }],
  });
  expect(t).toMatchObject({ language: "en", durationMs: 3400 });
  expect(t.turns).toEqual([{ speaker: null, startMs: 200, endMs: 3100, text: "Quick sync." }]);
});

describe("joinTurns", () => {
  it("keeps a turn apart after a pause longer than two seconds", () => {
    const turns = joinTurns([
      { speaker: "A", startMs: 0, endMs: 1000, text: "One." },
      { speaker: "A", startMs: 3500, endMs: 4000, text: "Two." },
    ]);
    expect(turns).toHaveLength(2);
  });

  it("cuts a monologue at ninety seconds so it still has times to jump to", () => {
    const turns = joinTurns(
      Array.from({ length: 20 }, (_, i) => ({
        speaker: "A",
        startMs: i * 10_000,
        endMs: i * 10_000 + 9_500,
        text: `Part ${i}.`,
      })),
    );
    expect(turns.length).toBeGreaterThan(1);
    for (const turn of turns) expect(turn.endMs - turn.startMs).toBeLessThanOrEqual(90_000);
  });

  it("puts out-of-order segments in time order and drops empty ones", () => {
    const turns = joinTurns([
      { speaker: "B", startMs: 5000, endMs: 6000, text: "Later." },
      { speaker: "A", startMs: 0, endMs: 1000, text: "  " },
      { speaker: "A", startMs: 1000, endMs: 2000, text: "First." },
    ]);
    expect(turns.map((t) => t.text)).toEqual(["First.", "Later."]);
  });
});
