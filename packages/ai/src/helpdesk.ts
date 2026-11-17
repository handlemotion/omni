import { read } from "./decide.ts";
import {
  MAX_SUGGESTED_TAGS,
  MAX_TAG_QUESTIONS,
  MAX_TEAMMATE_QUESTIONS,
  NOUL_YES,
  PRIORITY_JUDGMENTS,
  tagQuestion,
  teammateQuestion,
  type NoulQuestion,
  type PriorityJudgment,
} from "./questions.ts";
import type { Bucket, HelpdeskTag, HelpdeskTeammate, Priority } from "./types.ts";

export type PriorityJudgments = Record<PriorityJudgment, number>;

/**
 * First match wins. Only a settled yes raises the priority: a judgment between the bands leaves
 * the conversation at `normal`, where an agent sees it in the order it arrived. A message that
 * asks nothing of the team (`fyi`, `noise`) is `low` whatever else it says.
 */
export const PRIORITY_TABLE: ReadonlyArray<{
  when: (yes: (j: PriorityJudgment) => boolean, bucket: Bucket) => boolean;
  priority: Priority;
}> = [
  { when: (_, bucket) => bucket === "fyi" || bucket === "noise", priority: "low" },
  { when: (yes) => yes("sender_blocked") && yes("time_sensitive"), priority: "urgent" },
  {
    when: (yes) =>
      yes("sender_blocked") ||
      yes("time_sensitive") ||
      yes("money_at_stake") ||
      yes("sender_upset"),
    priority: "high",
  },
  { when: () => true, priority: "normal" },
];

export function decidePriority(judgments: PriorityJudgments, bucket: Bucket) {
  const yes = (j: PriorityJudgment) => read(judgments[j]) === "yes";
  return (PRIORITY_TABLE.find((row) => row.when(yes, bucket))?.priority ??
    "normal") satisfies Priority;
}

/** The tags Jev is asked about: the inbox's first `MAX_TAG_QUESTIONS`, keyed `tag_<index>`. */
export function tagQuestions(tags: readonly HelpdeskTag[]) {
  const asked = tags.slice(0, MAX_TAG_QUESTIONS);
  const questions: Record<string, NoulQuestion> = {};
  asked.forEach((tag, i) => {
    questions[`tag_${i}`] = tagQuestion(tag.name, tag.description);
  });
  return { asked, questions };
}

/** Tags whose Noul reads yes, most likely first, at most `MAX_SUGGESTED_TAGS`. */
export function pickTags(asked: readonly HelpdeskTag[], nouls: readonly number[]) {
  return asked
    .map((tag, i) => ({ id: tag.id, p: nouls[i] ?? 0 }))
    .filter((t) => t.p >= NOUL_YES)
    .sort((a, b) => b.p - a.p)
    .slice(0, MAX_SUGGESTED_TAGS)
    .map((t) => t.id) satisfies string[];
}

/** The teammates Jev is asked about: the first `MAX_TEAMMATE_QUESTIONS`, keyed `teammate_<index>`. */
export function teammateQuestions(teammates: readonly HelpdeskTeammate[] = []) {
  const asked = teammates.filter((t) => t.role.trim()).slice(0, MAX_TEAMMATE_QUESTIONS);
  const questions: Record<string, NoulQuestion> = {};
  asked.forEach((teammate, i) => {
    questions[`teammate_${i}`] = teammateQuestion(teammate.role.trim());
  });
  return { asked, questions };
}

/**
 * Who takes the conversation. Only a message that waits on the team (`needs_reply`) is handed to
 * anyone, and only to a teammate whose role reads a settled yes; among several, the most likely.
 * Otherwise nobody: it stays unassigned for a person to pick up.
 */
export function pickAssignee(
  asked: readonly HelpdeskTeammate[],
  nouls: readonly number[],
  bucket: Bucket,
) {
  if (bucket !== "needs_reply") return null;
  let best: string | null = null;
  let bestP = NOUL_YES;
  for (const [i, teammate] of asked.entries()) {
    const p = nouls[i] ?? 0;
    if (p >= bestP && (best === null || p > bestP)) {
      best = teammate.id;
      bestP = p;
    }
  }
  return best;
}

export { PRIORITY_JUDGMENTS };
