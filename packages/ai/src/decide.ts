// The triage truth table. Jev supplies the judgments; this file decides the bucket.

import {
  JUDGMENTS,
  NOUL_NO,
  NOUL_YES,
  UNSETTLED_CONFIDENCE_CAP,
  type Judgment,
} from "./questions.ts";
import type { Bucket } from "./types.ts";

/** A Noul read through the 0.7 / 0.3 bands: yes, no, or unsettled in between. */
export type Reading = "yes" | "no" | "unsettled";

export type Judgments = Record<Judgment, number>;
export type Readings = Record<Judgment, Reading>;

export function read(noul: number): Reading {
  if (noul >= NOUL_YES) return "yes";
  if (noul <= NOUL_NO) return "no";
  return "unsettled";
}

interface Row {
  /** Every listed judgment must read exactly this way. Unlisted judgments don't matter. */
  when: Partial<Record<Judgment, "yes" | "no">>;
  bucket: Bucket;
}

/** First match wins. Every settled combination matches a row (see decide.test.ts). */
export const TRIAGE_TABLE: readonly Row[] = [
  // A person is asking the reader for something.
  { when: { expects_reply: "yes", automated: "no", bulk: "no" }, bucket: "needs_reply" },
  // A person owes the reader something and asks nothing back.
  {
    when: { promises_follow_up: "yes", expects_reply: "no", automated: "no", bulk: "no" },
    bucket: "waiting_on_them",
  },
  // Bulk or automated mail: worth reading only when it concerns the reader.
  { when: { bulk: "yes", concerns_reader: "no" }, bucket: "noise" },
  { when: { automated: "yes", concerns_reader: "no" }, bucket: "noise" },
  { when: { bulk: "yes", concerns_reader: "yes" }, bucket: "fyi" },
  { when: { automated: "yes", concerns_reader: "yes" }, bucket: "fyi" },
  // A person writes to inform, with nothing asked and nothing promised.
  {
    when: { expects_reply: "no", promises_follow_up: "no", automated: "no", bulk: "no" },
    bucket: "fyi",
  },
];

export interface Decision {
  bucket: Bucket;
  confidence: number;
  /** The row that decided, or `unsettled` when a judgment it needed sat between the bands. */
  row: number | "unsettled";
}

function matches(row: Row, readings: Readings): boolean {
  return Object.entries(row.when).every(([j, want]) => readings[j as Judgment] === want);
}

/**
 * Confidence is the weakest link: the lowest probability, among the judgments the row relies
 * on, that the judgment really reads the way the row needs it to. Jev's Nouls are calibrated,
 * so "every deciding judgment is at least 85% likely" is what the 0.85 auto-file bar means.
 */
function weakestLink(row: Row, judgments: Judgments): number {
  return Math.min(
    ...Object.entries(row.when).map(([j, want]) => {
      const p = judgments[j as Judgment];
      return want === "yes" ? p : 1 - p;
    }),
  );
}

export function decide(judgments: Judgments): Decision {
  const readings = Object.fromEntries(JUDGMENTS.map((j) => [j, read(judgments[j])])) as Readings;
  const index = TRIAGE_TABLE.findIndex((row) => matches(row, readings));
  const row = TRIAGE_TABLE[index];
  if (row) return { bucket: row.bucket, confidence: weakestLink(row, judgments), row: index };

  // Unsettled: a judgment some row needed sat between the bands. Guess with each judgment
  // rounded to its likelier side, and cap the confidence so a person sorts it.
  const rounded = Object.fromEntries(
    JUDGMENTS.map((j) => [j, judgments[j] >= 0.5 ? "yes" : "no"]),
  ) as Readings;
  const guess = TRIAGE_TABLE.find((r) => matches(r, rounded));
  if (!guess) throw new Error("triage table has no row for a settled combination");
  return {
    bucket: guess.bucket,
    confidence: Math.min(weakestLink(guess, judgments), UNSETTLED_CONFIDENCE_CAP),
    row: "unsettled",
  };
}
