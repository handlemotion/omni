// The triage truth tables. Jev supplies the judgments; this file decides the bucket. Which table
// runs depends on who wrote the latest message, a fact code already knows: `TRIAGE_TABLE` when
// someone else did, `SENT_TABLE` when the reader did.

import {
  JUDGMENTS,
  NOUL_NO,
  NOUL_YES,
  SENT_JUDGMENTS,
  UNSETTLED_CONFIDENCE_CAP,
  type Judgment,
  type SentJudgment,
} from "./questions.ts";
import type { Bucket } from "./types.ts";

/** A Noul read through the 0.7 / 0.3 bands: yes, no, or unsettled in between. */
export type Reading = "yes" | "no" | "unsettled";

export type Judgments = Record<Judgment, number>;
export type SentJudgments = Record<SentJudgment, number>;

export function read(noul: number): Reading {
  if (noul >= NOUL_YES) return "yes";
  if (noul <= NOUL_NO) return "no";
  return "unsettled";
}

export interface Row<J extends string = string> {
  /** Every listed judgment must read exactly this way. Unlisted judgments don't matter. */
  when: Partial<Record<J, "yes" | "no">>;
  bucket: Bucket;
}

/**
 * Someone else wrote the latest message. First match wins. Every settled combination matches a
 * row (see decide.test.ts). `needs_reply` lives only here: it means someone else wrote last.
 */
export const TRIAGE_TABLE: readonly Row<Judgment>[] = [
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

/**
 * The reader wrote the latest message. They wait on the other side only if a person wrote it and
 * it asks for something; a closer ("thanks!", "sounds good"), an FYI they sent, or mail an app
 * sent from their address (a sign-in link) files as `fyi`.
 */
export const SENT_TABLE: readonly Row<SentJudgment>[] = [
  { when: { sent_by_system: "yes" }, bucket: "fyi" },
  { when: { reader_asks_question: "yes", sent_by_system: "no" }, bucket: "waiting_on_them" },
  { when: { reader_requests_action: "yes", sent_by_system: "no" }, bucket: "waiting_on_them" },
  { when: { reader_asks_question: "no", reader_requests_action: "no" }, bucket: "fyi" },
];

export interface Decision {
  bucket: Bucket;
  confidence: number;
  /** The row that decided, or `unsettled` when a judgment it needed sat between the bands. */
  row: number | "unsettled";
}

type Readings<J extends string> = Record<J, Reading>;

function matches<J extends string>(row: Row<J>, readings: Readings<J>): boolean {
  return Object.entries(row.when).every(([j, want]) => readings[j as J] === want);
}

/**
 * Confidence is the weakest link: the lowest probability, among the judgments the row relies
 * on, that the judgment really reads the way the row needs it to. Jev's Nouls are calibrated,
 * so "every deciding judgment is at least 85% likely" is what the 0.85 auto-file bar means.
 */
function weakestLink<J extends string>(row: Row<J>, judgments: Record<J, number>): number {
  return Math.min(
    ...Object.entries(row.when).map(([j, want]) => {
      const p = judgments[j as J];
      return want === "yes" ? p : 1 - p;
    }),
  );
}

function decideWith<J extends string>(
  table: readonly Row<J>[],
  keys: readonly J[],
  judgments: Record<J, number>,
): Decision {
  const readings = Object.fromEntries(keys.map((j) => [j, read(judgments[j])])) as Readings<J>;
  const index = table.findIndex((row) => matches(row, readings));
  const row = table[index];
  if (row) return { bucket: row.bucket, confidence: weakestLink(row, judgments), row: index };

  // Unsettled: a judgment some row needed sat between the bands. Guess with each judgment
  // rounded to its likelier side, and cap the confidence so a person sorts it.
  const rounded = Object.fromEntries(
    keys.map((j) => [j, judgments[j] >= 0.5 ? "yes" : "no"]),
  ) as Readings<J>;
  const guess = table.find((r) => matches(r, rounded));
  if (!guess) throw new Error("triage table has no row for a settled combination");
  return {
    bucket: guess.bucket,
    confidence: Math.min(weakestLink(guess, judgments), UNSETTLED_CONFIDENCE_CAP),
    row: "unsettled",
  };
}

/** Someone else wrote the latest message. */
export function decide(judgments: Judgments): Decision {
  return decideWith(TRIAGE_TABLE, JUDGMENTS, judgments);
}

/** The reader wrote the latest message. */
export function decideSent(judgments: SentJudgments): Decision {
  return decideWith(SENT_TABLE, SENT_JUDGMENTS, judgments);
}
