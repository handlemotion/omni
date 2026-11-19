import { describe, expect, test } from "vitest";
import { bySection, dayHeading, listTime } from "./list-dates.ts";

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe("dayHeading", () => {
  const now = new Date(2026, 10, 19, 0, 30);

  test("a message at 23:59 the night before is Yesterday, not Today", () => {
    expect(dayHeading(at(2026, 11, 18, 23, 59), now)).toBe("Yesterday");
    expect(dayHeading(at(2026, 11, 19, 0, 1), now)).toBe("Today");
  });

  test("Yesterday across a month boundary", () => {
    expect(dayHeading(at(2026, 10, 31, 22), new Date(2026, 10, 1, 8))).toBe("Yesterday");
  });

  test("Yesterday across a clock change (a 23-hour day)", () => {
    expect(dayHeading(at(2026, 3, 8, 1), new Date(2026, 2, 9, 1))).toBe("Yesterday");
    expect(dayHeading(at(2026, 3, 29, 1), new Date(2026, 2, 30, 1))).toBe("Yesterday");
  });

  test("a weekday within the week, then the month, with its year only when not this one", () => {
    expect(dayHeading(at(2026, 11, 16), now, "en-US")).toBe("Monday");
    expect(dayHeading(at(2026, 11, 2), now, "en-US")).toBe("November");
    expect(dayHeading(at(2025, 12, 30), now, "en-US")).toBe("December 2025");
  });

  test("a time in the future (a skewed clock) reads as Today, not as a weekday", () => {
    expect(dayHeading(at(2026, 11, 19, 9), now)).toBe("Today");
  });
});

describe("listTime", () => {
  const now = new Date(2026, 10, 19, 15);
  test("the year shows only for another year's date", () => {
    expect(listTime(at(2026, 1, 3), now, "en-US")).toBe("Jan 3");
    expect(listTime(at(2025, 11, 20), now, "en-US")).toBe("Nov 20, 2025");
  });
  test("within the week it's the weekday, not a date that reads like last month", () => {
    expect(listTime(at(2026, 11, 14), now, "en-US")).toBe("Sat");
  });
});

const row = (id: string, iso: string) => ({ id, iso });

describe("bySection", () => {
  const now = new Date(2026, 10, 19, 15);
  const run = (items: { id: string; iso: string }[]) =>
    bySection(
      items,
      (i) => i.id,
      (i) => i.iso,
      now,
      "en-US",
    ).map((r) => (r.kind === "heading" ? `# ${r.label}` : r.id));

  test("one heading per day, in order", () => {
    expect(
      run([
        row("a", at(2026, 11, 19, 9)),
        row("b", at(2026, 11, 19, 8)),
        row("c", at(2026, 11, 18)),
      ]),
    ).toEqual(["# Today", "a", "b", "# Yesterday", "c"]);
  });

  test("an out-of-order row never repeats a heading (list keys must stay unique)", () => {
    const out = bySection(
      [row("a", at(2026, 11, 19)), row("b", at(2026, 11, 18)), row("c", at(2026, 11, 19))],
      (i) => i.id,
      (i) => i.iso,
      now,
    );
    const ids = out.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
