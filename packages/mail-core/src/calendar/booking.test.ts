import { describe, expect, test } from "vitest";
import { bookingSlots, bookingWindow, isBookable, type BookingRules } from "./booking.ts";

const MADRID: BookingRules = {
  timeZone: "Europe/Madrid",
  weekdays: [1, 2, 3, 4, 5],
  startMinute: 9 * 60,
  endMinute: 12 * 60,
  durationMinutes: 60,
  noticeMinutes: 0,
  horizonDays: 7,
};

const iso = (dates: readonly Date[]) => dates.map((d) => d.toISOString());

const MONDAY_0600_MADRID = new Date("2026-11-23T05:00:00Z");
const SUNDAY_SPRING_FORWARD = new Date("2027-03-14T05:00:00Z");
const FRIDAY_BEFORE_WINTER_TIME = new Date("2026-10-23T04:00:00Z");

describe("bookingSlots", () => {
  test("slots are the link's hours in its own zone, not UTC's", () => {
    const slots = bookingSlots({ ...MADRID, horizonDays: 1 }, [], MONDAY_0600_MADRID);
    expect(iso(slots)).toEqual([
      "2026-11-23T08:00:00.000Z",
      "2026-11-23T09:00:00.000Z",
      "2026-11-23T10:00:00.000Z",
    ]);
  });

  test("a weekend offers nothing and the week goes on after it", () => {
    const days = new Set(
      bookingSlots(MADRID, [], MONDAY_0600_MADRID).map((d) => d.toISOString().slice(0, 10)),
    );
    expect([...days]).toEqual([
      "2026-11-23",
      "2026-11-24",
      "2026-11-25",
      "2026-11-26",
      "2026-11-27",
    ]);
  });

  test("a busy block takes the slots it overlaps and leaves the ones it only touches", () => {
    const busy = [
      { start: new Date("2026-11-23T08:30:00Z"), end: new Date("2026-11-23T09:00:00Z") },
    ];
    const slots = bookingSlots({ ...MADRID, horizonDays: 1 }, busy, MONDAY_0600_MADRID);
    expect(iso(slots)).toEqual(["2026-11-23T09:00:00.000Z", "2026-11-23T10:00:00.000Z"]);
  });

  test("a slot that would run past closing is not offered", () => {
    const slots = bookingSlots(
      { ...MADRID, durationMinutes: 50, horizonDays: 1 },
      [],
      MONDAY_0600_MADRID,
    );
    expect(iso(slots)).toEqual([
      "2026-11-23T08:00:00.000Z",
      "2026-11-23T08:50:00.000Z",
      "2026-11-23T09:40:00.000Z",
    ]);
  });

  test("nothing starts in the past or inside the notice", () => {
    const now = new Date("2026-11-23T08:10:00Z");
    const slots = bookingSlots({ ...MADRID, noticeMinutes: 60, horizonDays: 1 }, [], now);
    expect(iso(slots)).toEqual(["2026-11-23T10:00:00.000Z"]);
  });

  test("a slot keeps its local hour across the change to winter time", () => {
    const rules = { ...MADRID, weekdays: [5, 1], durationMinutes: 180, horizonDays: 4 };
    const slots = bookingSlots(rules, [], FRIDAY_BEFORE_WINTER_TIME);
    expect(iso(slots)).toEqual(["2026-10-23T07:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
  });

  test("a slot across the change to summer time is checked for as long as the meeting lasts", () => {
    const rules: BookingRules = {
      timeZone: "America/New_York",
      weekdays: [0],
      startMinute: 90,
      endMinute: 300,
      durationMinutes: 90,
      noticeMinutes: 0,
      horizonDays: 1,
    };
    const busy = [
      { start: new Date("2027-03-14T07:15:00Z"), end: new Date("2027-03-14T07:30:00Z") },
    ];
    const slots = bookingSlots(rules, busy, SUNDAY_SPRING_FORWARD);
    expect(iso(slots)).not.toContain("2027-03-14T06:30:00.000Z");
  });

  test("a start the clocks skip is not offered, so each slot is offered once and in order", () => {
    const rules: BookingRules = {
      timeZone: "America/New_York",
      weekdays: [0],
      startMinute: 60,
      endMinute: 300,
      durationMinutes: 30,
      noticeMinutes: 0,
      horizonDays: 1,
    };
    const slots = iso(bookingSlots(rules, [], SUNDAY_SPRING_FORWARD));
    expect(slots).toEqual([...new Set(slots)].toSorted());
    expect(slots).toEqual([
      "2027-03-14T06:00:00.000Z",
      "2027-03-14T06:30:00.000Z",
      "2027-03-14T07:00:00.000Z",
      "2027-03-14T07:30:00.000Z",
      "2027-03-14T08:00:00.000Z",
      "2027-03-14T08:30:00.000Z",
    ]);
  });

  test("the window starts at today's midnight in the link's zone", () => {
    const window = bookingWindow({ ...MADRID, horizonDays: 2 }, MONDAY_0600_MADRID);
    expect(window.from.toISOString()).toBe("2026-11-22T23:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-11-24T23:00:00.000Z");
  });

  test("only an offered start is bookable", () => {
    expect(isBookable(MADRID, [], MONDAY_0600_MADRID, new Date("2026-11-23T09:00:00Z"))).toBe(true);
    expect(isBookable(MADRID, [], MONDAY_0600_MADRID, new Date("2026-11-23T09:15:00Z"))).toBe(
      false,
    );
    expect(isBookable(MADRID, [], MONDAY_0600_MADRID, new Date("2026-11-28T09:00:00Z"))).toBe(
      false,
    );
  });
});
