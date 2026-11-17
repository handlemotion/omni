import { describe, expect, test } from "vitest";
import { addBusinessMinutes, type BusinessSchedule } from "./business-hours.ts";

const weekdays = (start: string, end: string, timezone = "America/Mexico_City") =>
  ({
    timezone,
    windows: ([1, 2, 3, 4, 5] as const).map((day) => ({ day, start, end })),
    holidays: [],
  }) satisfies BusinessSchedule;

const cdmx = (iso: string) => new Date(`${iso}-06:00`);

describe("addBusinessMinutes", () => {
  test("time past closing carries over the weekend to Monday's opening", () => {
    const friday = cdmx("2026-11-13T16:30:00");
    expect(addBusinessMinutes(friday, 60, weekdays("09:00", "17:00"))).toEqual(
      cdmx("2026-11-16T09:30:00"),
    );
  });

  test("a message before opening starts counting at opening, not at midnight", () => {
    const early = cdmx("2026-11-12T06:00:00");
    expect(addBusinessMinutes(early, 120, weekdays("09:00", "17:00"))).toEqual(
      cdmx("2026-11-12T11:00:00"),
    );
  });

  test("windows are in the inbox's zone and keep local opening time across a DST change", () => {
    const ny = weekdays("09:00", "17:00", "America/New_York");
    const friday = new Date("2026-03-06T21:00:00Z");
    expect(addBusinessMinutes(friday, 90, ny)).toEqual(new Date("2026-03-09T13:30:00Z"));
  });

  test("a window in the hour repeated when DST ends opens at its first occurrence", () => {
    const berlin: BusinessSchedule = {
      timezone: "Europe/Berlin",
      windows: [{ day: 0, start: "02:00", end: "03:00" }],
      holidays: [],
    };
    expect(addBusinessMinutes(new Date("2026-10-24T22:00:00Z"), 30, berlin)).toEqual(
      new Date("2026-10-25T00:30:00Z"),
    );
  });

  test("a target longer than a year of staffed time still gets a due time", () => {
    const due = addBusinessMinutes(
      cdmx("2026-11-12T09:00:00"),
      525_600,
      weekdays("09:00", "17:00"),
    );
    expect(due).not.toBeNull();
    expect(due!.getUTCFullYear()).toBe(2031);
  });

  test("holidays are closed all day", () => {
    const schedule = { ...weekdays("09:00", "17:00"), holidays: ["2026-11-16"] };
    expect(addBusinessMinutes(cdmx("2026-11-13T16:30:00"), 60, schedule)).toEqual(
      cdmx("2026-11-17T09:30:00"),
    );
  });

  test("split shifts skip the gap, and overlapping windows count once", () => {
    const schedule: BusinessSchedule = {
      timezone: "America/Mexico_City",
      windows: [
        { day: 4, start: "09:00", end: "13:00" },
        { day: 4, start: "12:00", end: "13:00" },
        { day: 4, start: "15:00", end: "19:00" },
      ],
      holidays: [],
    };
    expect(addBusinessMinutes(cdmx("2026-11-12T12:00:00"), 120, schedule)).toEqual(
      cdmx("2026-11-12T16:00:00"),
    );
  });

  test("no schedule counts every minute; a schedule that never opens gives no due time", () => {
    const start = new Date("2026-11-12T10:00:00Z");
    expect(addBusinessMinutes(start, 30, null)).toEqual(new Date("2026-11-12T10:30:00Z"));
    const never: BusinessSchedule = {
      timezone: "UTC",
      windows: [{ day: 1, start: "09:00", end: "10:00" }],
      holidays: Array.from({ length: 60 }, (_, i) =>
        new Date(Date.UTC(2026, 10, 16 + i * 7)).toISOString().slice(0, 10),
      ),
    };
    expect(addBusinessMinutes(start, 30, never)).toBeNull();
  });
});
