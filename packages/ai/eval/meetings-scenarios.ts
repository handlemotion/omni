import { readFileSync } from "node:fs";
import { fromAssemblyAI } from "../src/meetings/transcript.ts";
import { resolveSpeakers, speakerTitles, type Person } from "../src/meetings/speakers.ts";
import type { NameSpeakersInput } from "../src/meetings/naming.ts";
import type { WriteNotesInput } from "../src/meetings/notes.ts";
import type { GroupMeeting } from "../src/meetings/group.ts";
import type { AskMeeting } from "../src/meetings/ask.ts";

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

const weeks = (n: number) => new Date(Date.UTC(2026, 10, 2 + 7 * n, 15));

const kickoffWeeks: GroupMeeting[] = [
  {
    title: "Week Kickoff",
    startedAt: weeks(2),
    summary:
      "The team agreed to ship the retention dashboard on December 4 and to drop the CSV export from the first release.",
    highlights: [
      { text: "Retention dashboard ships December 4.", atMs: 125_000 },
      { text: "CSV export moves to the second release.", atMs: 410_000 },
    ],
  },
  {
    title: "Week Kickoff",
    startedAt: weeks(1),
    summary:
      "Priya showed the first cohort chart; the numbers were off by one week, and José took the fix.",
    highlights: [{ text: "José fixes the cohort week offset by Friday.", atMs: 300_000 }],
  },
  {
    title: "Week Kickoff",
    startedAt: weeks(0),
    summary:
      "Kickoff of the retention project with a budget of 18,000 dollars and a first review in two weeks.",
    highlights: [{ text: "Budget set at 18,000 dollars.", atMs: 95_000 }],
  },
];

/** Each group scenario, and words its summary must hold. */
export const groupScenarios: Array<{ id: string; meetings: GroupMeeting[]; holds: string[] }> = [
  { id: "group-kickoffs-en", meetings: kickoffWeeks, holds: ["december 4"] },
];

const callMeeting: AskMeeting = {
  id: "m-call",
  title: "Entregas sitio web",
  startedAt: weeks(2),
  durationMs: call.durationMs,
  summary:
    "Dana y Marta revisaron el calendario de entregas: acceso al servidor hoy, diseño el viernes y lanzamiento el día 12.",
  highlights: [{ text: "Lanzamiento confirmado para el día 12.", atMs: 27_000 }],
  transcript: { turns: call.turns, titles: speakerTitles(callSpeakers) },
};

/** Each Ask scenario: the meeting a citation must point at, and words the answer must hold. */
export const askScenarios: Array<{
  id: string;
  question: string;
  meetings: AskMeeting[];
  holds: { words: string[]; citesMeeting: string };
}> = [
  {
    id: "ask-call-es",
    question: "¿Cuándo es el lanzamiento y de qué depende el deploy?",
    meetings: [callMeeting],
    holds: { words: ["12"], citesMeeting: "m-call" },
  },
  {
    id: "ask-group-en",
    question: "When does the retention dashboard ship, and what was cut?",
    meetings: kickoffWeeks.map((m, i) => ({
      ...m,
      id: `m-week-${i}`,
      durationMs: 3_600_000,
      transcript: null,
    })),
    holds: { words: ["december 4", "csv"], citesMeeting: "m-week-0" },
  },
];
