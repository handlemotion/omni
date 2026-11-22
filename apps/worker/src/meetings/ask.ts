import Anthropic from "@anthropic-ai/sdk";
import {
  askMeetings,
  speakerTitles,
  summarizeGroup,
  type AskMeeting,
  type GroupMeeting,
} from "@omni/ai";
import { askMeetingsBodySchema, type MeetingsAskResponse } from "@omni/contracts";
import { meetingsPipeline, type AskSource, type Db } from "@omni/db";
import { recordAiUsage } from "../ai-usage.ts";
import { Hono, type Context } from "hono";
import { requireMeter } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import type { Config } from "../env.ts";
import { apiError } from "../errors.ts";
import type { Logger } from "../log.ts";
import { zValidator } from "../validator.ts";
import { memberMeetings, refused } from "./http.ts";

const MODEL_TIMEOUT_MS = 60_000;

/** The model for group summaries and Ask; null when the deployment has none. */
export function meetingsModel(config: Config) {
  if (!config.ANTHROPIC_API_KEY) return null;
  return new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    baseURL: config.ANTHROPIC_BASE_URL ?? null,
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 1,
  });
}

interface Digest {
  meetings: ReadonlyArray<GroupMeeting & { orgId: string }>;
  meetingsHash: string | null;
  cached: { summary: string } | null;
}

/**
 * A group's summary for one reader: the one kept for exactly the meetings they can open, or a
 * new one made from those meetings' notes and kept under them. Readers who see the same meetings
 * share it; a meeting gaining notes changes the set, so the next read makes it again. Making it
 * twice at once keeps one (the key is the set). Null when there is nothing to summarize or no
 * model; a model failure is logged and the page loads without it.
 */
export async function groupSummary(
  deps: { db: Db; config: Config; log: Logger },
  groupKey: string,
  digest: Digest,
) {
  if (digest.cached) return digest.cached.summary;
  const [newest] = digest.meetings;
  const client = meetingsModel(deps.config);
  if (!newest || !digest.meetingsHash || !client) return null;
  try {
    const { summary, usage } = await summarizeGroup(client, digest.meetings);
    await recordAiUsage(deps.db, newest.orgId, usage);
    if (!summary) return null;
    await meetingsPipeline(deps.db).saveGroupSummary(
      newest.orgId,
      groupKey,
      digest.meetingsHash,
      summary,
      newest.startedAt,
    );
    return summary;
  } catch (error) {
    deps.log.warn("meetings.group_summary_failed", { error });
    return null;
  }
}

const asked = (source: AskSource) =>
  ({
    id: source.id,
    title: source.title,
    startedAt: source.startedAt,
    durationMs: source.durationMs,
    summary: source.summary,
    highlights: source.highlights,
    transcript: source.transcript
      ? {
          turns: source.transcript.turns,
          titles: speakerTitles(
            source.transcript.speakers.map((s) => ({
              label: s.label,
              name: s.name,
              address: null,
              source: null,
              confidence: 0,
            })),
          ),
        }
      : null,
  }) satisfies AskMeeting;

/**
 * Answers `question` from `sources`, which the caller's door already limited to meetings the
 * asker can open. Counts one `assist` against the meetings' workspace before the model runs.
 */
export async function answerAsk(c: Context<AppEnv>, question: string, sources: AskSource[]) {
  const client = meetingsModel(c.var.config);
  const [first] = sources;
  if (!client || !first) return apiError(c, "not_found", "not found");
  await requireMeter(c.var.db, c.var.config, {
    orgId: first.orgId,
    meter: "assist",
    key: `meetings-ask:${crypto.randomUUID()}`,
  });
  const result = await askMeetings(client, question, sources.map(asked));
  await recordAiUsage(c.var.db, first.orgId, result.usage);
  if (!result.ok) return apiError(c, "bad_gateway", "the question could not be answered");
  return c.json({
    answer: result.answer,
    citations: result.citations,
  } satisfies MeetingsAskResponse);
}

/** `POST /ask` for members: one meeting they can open, or their meetings in one group. */
export const memberAsk = new Hono<AppEnv>().post(
  "/ask",
  zValidator("json", askMeetingsBodySchema),
  async (c) => {
    const { meetingId, groupKey, question } = c.req.valid("json");
    const door = memberMeetings(c);
    const found = meetingId
      ? await door.askSources(meetingId)
      : await door.groupAskSources(groupKey ?? "", question);
    if (found.status !== "ok") return refused(c, found);
    return answerAsk(c, question, [...found.meetings]);
  },
);
