import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { result, toolError } from "../format.ts";
import {
  clock,
  group,
  groupInput,
  groupSchema,
  meetingsOf,
  meetingsWorkspaces,
  meetingUrl,
  THIRD_PARTY,
} from "../meetings.ts";
import { guarded, type ToolContext } from "../server.ts";

const when = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "an ISO 8601 date or time")
  .transform((value) => new Date(value));

const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .max(500)
    .default("")
    .describe(
      'Words said in the meeting or in its notes and title, web search syntax ("exact phrase", -exclude, or). Empty: list meetings by the filters, newest first.',
    ),
  people: z
    .array(z.string().trim().min(2).max(200))
    .max(5)
    .default([])
    .describe(
      "People who were in the meeting, by address (ana@acme.com) or part of a name (Ana). Each must be an attendee or a speaker.",
    ),
  after: when.optional().describe("Started at or after (ISO 8601)."),
  before: when.optional().describe("Started before (ISO 8601)."),
  group: groupInput.optional(),
  workspace: z.string().min(1).optional().describe("One workspace id."),
  limit: z.number().int().min(1).max(50).default(10),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().describe("The meeting id, for `meetings_fetch`."),
      title: z.string().nullable(),
      url: z.string().describe("Open the meeting in Omni. Cite it when you answer."),
      workspace: z.string().describe("The workspace's name."),
      started_at: z.string(),
      ended_at: z.string().nullable(),
      duration_ms: z.number().nullable(),
      status: z
        .string()
        .describe("`ready` once its transcript and notes are in; earlier while it is processed."),
      group: groupSchema,
      summary: z.string().nullable().describe("The notes' summary; null before the notes."),
      match: z
        .object({
          at: z.string().describe("When it was said, `mm:ss` into the recording."),
          at_ms: z.number(),
          speaker: z
            .string()
            .nullable()
            .describe("Who said it; null when the speaker has no name."),
          text: z.string(),
        })
        .nullable()
        .describe(
          "With `query`: the turn of the transcript that matches best, when the words were said; null when only the notes or the title hold them.",
        ),
    }),
  ),
});

async function find(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const wait = await context.rateLimit("search");
  if (wait) return toolError(`Too many searches. Try again in ${wait} seconds.`);
  const reached = await meetingsWorkspaces(context, input.workspace);
  if ("error" in reached) return toolError(reached.error);
  const filter = {
    words: input.query,
    people: input.people,
    from: input.after ?? null,
    to: input.before ?? null,
    groupKey: input.group,
    limit: input.limit,
  };
  const found = await Promise.all(
    reached.workspaces.map(async (workspace) => {
      const listed = await meetingsOf(context, workspace).find(filter);
      return listed.status === "ok" ? listed.meetings.map((m) => ({ m, workspace })) : [];
    }),
  );
  const results = found
    .flat()
    .toSorted((a, b) => b.m.startedAt.getTime() - a.m.startedAt.getTime())
    .slice(0, input.limit)
    .map(({ m, workspace }) => ({
      id: m.id,
      title: m.title,
      url: meetingUrl(context.webAppURL, workspace, m.id),
      workspace: workspace.name,
      started_at: m.startedAt.toISOString(),
      ended_at: m.endedAt?.toISOString() ?? null,
      duration_ms: m.durationMs,
      status: m.status,
      group: group(context.webAppURL, workspace, m.groupKey),
      summary: m.summary,
      match: m.turn
        ? {
            at: clock(m.turn.startMs),
            at_ms: m.turn.startMs,
            speaker: m.turn.speakerName,
            text: m.turn.text,
          }
        : null,
    }));
  return result({ results });
}

export function registerMeetingsSearch(server: McpServer, context: ToolContext) {
  server.registerTool(
    "meetings_search",
    {
      title: "Search meetings",
      description: `Find recorded meetings the person can open, by words said in them or in their notes, by who was in them, by dates and by group (a recurring meeting's series, or a client's domain). Newest first. Returns ids to pass to \`meetings_fetch\`, which reads up to 10 meetings at once with their notes, actions and named transcript. ${THIRD_PARTY}`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "meetings_search", () => find(context, input)),
  );
}
