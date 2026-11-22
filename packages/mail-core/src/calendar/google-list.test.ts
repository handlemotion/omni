import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readGoogleCalendar, readGoogleCalendars } from "./google-list.ts";

const list = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../fixtures/google-calendar/calendar-list.json"),
    "utf8",
  ),
) as { items: Record<string, unknown>[] };

describe("readGoogleCalendars", () => {
  test("every calendar of the account reads, the primary one marked, each by the name the account gave it", () => {
    expect(readGoogleCalendars(list.items)).toEqual([
      {
        googleId: "rodrigo@studio.example",
        name: "rodrigo@studio.example",
        color: "#9fe1e7",
        primary: true,
      },
      {
        googleId: "c_0f3a9d2b7e41c6a8@group.calendar.google.com",
        name: "Studio team",
        color: "#fa573c",
        primary: false,
      },
      {
        googleId: "es.mexican#holiday@group.v.calendar.google.com",
        name: "Holidays in Mexico",
        color: "#16a765",
        primary: false,
      },
      {
        googleId: "ruiz.family.4x2@gmail.example",
        name: "Family",
        color: "#ac725e",
        primary: false,
      },
    ]);
  });

  test("a listed twice calendar reads once, and a deleted or id-less entry not at all", () => {
    const [first] = list.items;
    expect(
      readGoogleCalendars([
        first,
        { ...first, summary: "again" },
        { id: "gone@group.calendar.google.com", deleted: true },
        { summary: "no id" },
        { id: { nested: true } },
        "not an entry",
      ]).map((c) => c.googleId),
    ).toEqual(["rodrigo@studio.example"]);
  });

  test("a colour Omni cannot show is no colour, so the app's default stands", () => {
    for (const backgroundColor of ["red", "#fff", "url(x)", 7, undefined]) {
      expect(
        readGoogleCalendar({ id: "x@group.calendar.google.com", backgroundColor })?.color,
      ).toBe(null);
    }
  });
});
