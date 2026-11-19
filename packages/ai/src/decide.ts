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

export const read: (noul: number) => Reading = (noul) => {
  if (noul >= NOUL_YES) return "yes";
  if (noul <= NOUL_NO) return "no";
  return "unsettled";
};

export interface Row<J extends string = string> {
  /** Every listed judgment must read exactly this way. Unlisted judgments don't matter. */
  when: Partial<Record<J, "yes" | "no">>;
  /** `null`: no lane. */
  bucket: Bucket | null;
}

/**
 * Someone else wrote the latest message. First match wins. Every settled combination matches a
 * row (see decide.test.ts). `needs_reply` lives only here: it means someone else wrote last. Mail
that concerns the reader but asks nothing of them (a receipt, a notice) gets no lane (`null`);
`concerns_reader` is what tells it from `noise`.
 */
export const TRIAGE_TABLE: readonly Row<Judgment>[] = [
  { when: { expects_reply: "yes", automated: "no", bulk: "no" }, bucket: "needs_reply" },
  {
    when: { promises_follow_up: "yes", expects_reply: "no", automated: "no", bulk: "no" },
    bucket: "waiting_on_them",
  },
  { when: { bulk: "yes", concerns_reader: "no" }, bucket: "noise" },
  { when: { automated: "yes", concerns_reader: "no" }, bucket: "noise" },
  { when: { bulk: "yes", concerns_reader: "yes" }, bucket: null },
  { when: { automated: "yes", concerns_reader: "yes" }, bucket: null },
  {
    when: { expects_reply: "no", promises_follow_up: "no", automated: "no", bulk: "no" },
    bucket: null,
  },
];

/**
 * The reader wrote the latest message. They wait on the other side only if a person wrote it and
 * it asks for something; a closer ("thanks!", "sounds good"), a note that asks nothing, or mail an
 * app sent from their address (a sign-in link) gets no lane (`null`).
 */
export const SENT_TABLE: readonly Row<SentJudgment>[] = [
  { when: { sent_by_system: "yes" }, bucket: null },
  { when: { reader_asks_question: "yes", sent_by_system: "no" }, bucket: "waiting_on_them" },
  { when: { reader_requests_action: "yes", sent_by_system: "no" }, bucket: "waiting_on_them" },
  { when: { reader_asks_question: "no", reader_requests_action: "no" }, bucket: null },
];

export interface Decision {
  bucket: Bucket | null;
  confidence: number;
  /** The row that decided, or `unsettled` when a judgment it needed sat between the bands. */
  row: number | "unsettled";
}

type Readings<J extends string> = Record<J, Reading>;

function matches<J extends string>(row: Row<J>, readings: Readings<J>) {
  return Object.entries(row.when).every(([j, want]) => readings[j as J] === want);
}

function weakestLink<J extends string>(row: Row<J>, judgments: Record<J, number>) {
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
) {
  const readings = Object.fromEntries(keys.map((j) => [j, read(judgments[j])])) as Readings<J>;
  const index = table.findIndex((row) => matches(row, readings));
  const row = table[index];
  if (row)
    return {
      bucket: row.bucket,
      confidence: weakestLink(row, judgments),
      row: index,
    } satisfies Decision;

  const rounded = Object.fromEntries(
    keys.map((j) => [j, judgments[j] >= 0.5 ? "yes" : "no"]),
  ) as Readings<J>;
  const guess = table.find((r) => matches(r, rounded));
  if (!guess) throw new Error("triage table has no row for a settled combination");
  return {
    bucket: guess.bucket,
    confidence: Math.min(weakestLink(guess, judgments), UNSETTLED_CONFIDENCE_CAP),
    row: "unsettled",
  } satisfies Decision;
}

/** Someone else wrote the latest message. */
export function decide(judgments: Judgments) {
  return decideWith(TRIAGE_TABLE, JUDGMENTS, judgments) satisfies Decision;
}

/** The reader wrote the latest message. */
export function decideSent(judgments: SentJudgments) {
  return decideWith(SENT_TABLE, SENT_JUDGMENTS, judgments) satisfies Decision;
}
