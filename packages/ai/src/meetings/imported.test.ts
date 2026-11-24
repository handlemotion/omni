import { describe, expect, it } from "vitest";
import { importForeignMeeting, sectionsOf, type ForeignMeeting } from "./imported.ts";

const meeting: ForeignMeeting = {
  id: "cb-1",
  name: "  Venue review ",
  createdAt: "2026-11-19T17:27:34.826Z",
  duration: 60,
  attendees: [
    { name: "Ana Ruiz", email: "Ana@Example.com" },
    { name: "Participant 3", email: null },
    { name: "Ana again", email: "ana@example.com" },
  ],
  notes: [
    "#### Resumen",
    "* La cooperativa vende **80%** de su café a GRG",
    "* Volverán a contactar a José.",
    "",
    "#### Certificaciones",
    "* Dejaron la certificación orgánica porque costaba casi **$200,000**",
    "#### Maquinaria",
    "- La maquinaria de trillado cuesta 2.5 millones",
  ].join("\n"),
  actionItems: [
    {
      title: "Share  the results",
      description: " ",
      assignee: { name: "Ana Ruiz" },
      status: "DONE",
    },
    { title: "Call the bank", assignee: null, status: "PENDING" },
    { title: "  ", status: "PENDING" },
  ],
  transcript: [
    { speaker: "Participant 3", text: "Hablemos de la maquinaria de trillado.", timestamp: 40 },
    { speaker: "Ana Ruiz", text: "Hola a todos.", timestamp: 0 },
    { speaker: "Participant 3", text: "  ", timestamp: 5 },
    { speaker: "Ana Ruiz", text: "La certificación orgánica costaba demasiado.", timestamp: 10.5 },
  ],
};

describe("importForeignMeeting", () => {
  const imported = importForeignMeeting(meeting);

  it("orders the transcript, drops empty lines and ends each where the next starts", () => {
    expect(imported.turns).toEqual([
      { speaker: "Ana Ruiz", startMs: 0, endMs: 10_500, text: "Hola a todos." },
      {
        speaker: "Ana Ruiz",
        startMs: 10_500,
        endMs: 40_000,
        text: "La certificación orgánica costaba demasiado.",
      },
      {
        speaker: "Participant 3",
        startMs: 40_000,
        endMs: 60_000,
        text: "Hablemos de la maquinaria de trillado.",
      },
    ]);
  });

  it("names only the speakers the notetaker named, linking them to attendees by name", () => {
    expect(imported.speakers).toEqual([
      { label: "Ana Ruiz", name: "Ana Ruiz", address: "ana@example.com" },
      { label: "Participant 3", name: null, address: null },
    ]);
  });

  it("keeps attendees with an address once, lowercase", () => {
    expect(imported.attendees).toEqual([{ address: "ana@example.com", name: "Ana Ruiz" }]);
  });

  it("makes the first section the summary and the rest chapters at the line that says them", () => {
    expect(imported.notes?.summary).toBe(
      "La cooperativa vende 80% de su café a GRG. Volverán a contactar a José.",
    );
    expect(imported.notes?.chapters).toEqual([
      {
        title: "Certificaciones",
        startMs: 10_500,
        points: ["Dejaron la certificación orgánica porque costaba casi $200,000"],
      },
      {
        title: "Maquinaria",
        startMs: 40_000,
        points: ["La maquinaria de trillado cuesta 2.5 millones"],
      },
    ]);
    expect(imported.notes?.topics).toEqual(["Certificaciones", "Maquinaria"]);
  });

  it("keeps titled actions, their owner and whether they were done", () => {
    expect(imported.actions).toEqual([
      {
        payload: { title: "Share the results", description: null, owner: "Ana Ruiz" },
        done: true,
      },
      { payload: { title: "Call the bank", description: null, owner: null }, done: false },
    ]);
  });

  it("never ends before the last line, even when the duration is missing or short", () => {
    const short = importForeignMeeting({ ...meeting, duration: null });
    expect(short.durationMs).toBe(40_000);
    expect(short.turns.at(-1)).toMatchObject({ startMs: 40_000, endMs: 40_000 });
  });

  it("has no notes when the notetaker wrote none", () => {
    expect(importForeignMeeting({ ...meeting, notes: "" }).notes).toBeNull();
  });
});

describe("sectionsOf", () => {
  it("keeps text before the first heading as a summary with no title", () => {
    expect(sectionsOf("Just a line\n## Next\n1. one")).toEqual([
      { title: "", points: ["Just a line"] },
      { title: "Next", points: ["one"] },
    ]);
  });
});
