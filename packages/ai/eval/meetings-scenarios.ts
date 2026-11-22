import { readFileSync } from "node:fs";
import { fromAssemblyAI } from "../src/meetings/transcript.ts";
import { resolveSpeakers, speakerTitles, type Person } from "../src/meetings/speakers.ts";
import type { NameSpeakersInput } from "../src/meetings/naming.ts";
import type { WriteNotesInput } from "../src/meetings/notes.ts";

const root = new URL("../../../fixtures/meetings/", import.meta.url);
const engine = (file: string) =>
  fromAssemblyAI(JSON.parse(readFileSync(new URL(file, root), "utf8")));

const dana: Person = { address: "dana@studio.test", name: "Dana Ruiz" };
const marta: Person = { address: "marta@client.test", name: "Marta Gil" };
const jose: Person = { address: "jose@studio.test", name: "José Ortega" };
const priya: Person = { address: "priya@studio.test", name: "Priya Nair" };

const call = engine("assemblyai-two-person.json");
const callSpeakers = resolveSpeakers({
  turns: call.turns,
  micSpans: call.turns.filter((t) => t.speaker === "A"),
  recorder: dana,
  attendees: [dana, marta],
  engineNames: {},
});

const kickoff = engine("assemblyai-named.json");
const kickoffSpeakers = resolveSpeakers({
  turns: kickoff.turns,
  micSpans: kickoff.turns.filter((t) => t.speaker === "A"),
  recorder: dana,
  attendees: [dana, jose, priya],
  engineNames: { "Priya Nair": "Priya Nair" },
});

/** Each notes scenario, and what its notes must hold. */
export const notesScenarios: Array<{
  id: string;
  input: WriteNotesInput;
  holds: { summaryWords: string[]; emailTo: string | null; taskWord: string };
}> = [
  {
    id: "notes-two-person-es",
    input: {
      title: "Entregas sitio web",
      description: null,
      attendees: [dana, marta],
      personNotes: "- acceso servidor\n- lanzamiento 12",
      turns: call.turns,
      titles: speakerTitles(callSpeakers),
      durationMs: call.durationMs,
      language: call.language,
    },
    holds: { summaryWords: ["acceso"], emailTo: marta.address, taskWord: "acceso" },
  },
  {
    id: "notes-kickoff-en",
    input: {
      title: null,
      description: null,
      attendees: [dana, jose, priya],
      personNotes: null,
      turns: kickoff.turns,
      titles: speakerTitles(kickoffSpeakers),
      durationMs: kickoff.durationMs,
      language: kickoff.language,
    },
    holds: { summaryWords: ["retention"], emailTo: null, taskWord: "cohort" },
  },
];

/** Each names scenario, and the address each label must end up with (null: left unnamed). */
export const namingScenarios: Array<{
  id: string;
  input: NameSpeakersInput;
  expect: Record<string, string | null>;
}> = [
  {
    id: "naming-kickoff",
    input: { turns: kickoff.turns, speakers: kickoffSpeakers, attendees: [dana, jose, priya] },
    expect: { C: jose.address },
  },
  {
    id: "naming-call-no-mic",
    input: {
      turns: call.turns,
      speakers: resolveSpeakers({
        turns: call.turns,
        micSpans: null,
        recorder: dana,
        attendees: [dana, marta],
        engineNames: {},
      }),
      attendees: [dana, marta],
    },
    expect: { B: marta.address },
  },
];

export const meetingsRecordingUrl = (id: string) => new URL(`recordings/${id}.json`, root);
