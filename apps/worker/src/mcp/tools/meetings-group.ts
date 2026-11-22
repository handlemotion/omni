import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { result, toolError } from "../format.ts";
import {
  clock,
  group,
  groupInput,
  groupSchema,
  groupTitle,
  meetingsOf,
  meetingsWorkspaces,
  meetingUrl,
  THIRD_PARTY,
  type MeetingsWorkspace,
} from "../meetings.ts";
import { guarded, type ToolContext } from "../server.ts";

const MEETINGS_MAX = 50;

const inputSchema = z.object({
  group: groupInput
    .optional()
    .describe(
      "A group's `key`, or a client's domain such as `acme.com`. Leave it out to list the groups, newest first.",
    ),
  workspace: z.string().min(1).optional().describe("One workspace id."),
  limit: z.number().int().min(1).max(MEETINGS_MAX).default(20),
});

const meetingRow = z.object({
  id: z.string().describe("The meeting id, for `meetings_fetch`."),
  title: z.string().nullable(),
  url: z.string(),
  started_at: z.string(),
  summary: z.string().nullable(),
});

const outputSchema = z.object({
  groups: z.array(
    groupSchema.extend({
      title: z.string().describe("The client's domain, else the latest meeting's title."),
      workspace: z.string(),
      meeting_count: z.number().describe("The meetings in it the person can open."),
      last_started_at: z.string().nullable(),
      summary: z
        .string()
        .nullable()
        .optional()
        .describe(
          "With `group`: where things stand across its latest 12 meetings, written by AI from their notes; null until it is written.",
        ),
      timeline: z
        .array(
          z.object({
            meeting_id: z.string(),
            started_at: z.string(),
            at: z.string().describe("The moment in that meeting, `mm:ss`."),
            text: z.string(),
          }),
        )
        .optional()
        .describe("With `group`: every meeting's highlights, newest meeting first."),
      meetings: z
        .array(meetingRow)
        .optional()
        .describe("With `group`: its meetings the person can open, newest first."),
    }),
  ),
});

type Output = z.infer<typeof outputSchema>["groups"][number];

async function listGroups(context: ToolContext, workspaces: MeetingsWorkspace[], limit: number) {
  const listed = await Promise.all(
    workspaces.map(async (workspace) => {
      const page = await meetingsOf(context, workspace).groups({ limit });
      if (page.status !== "ok") return [];
      return page.groups.map(
        (g) =>
          ({
            ...group(context.webAppURL, workspace, g.groupKey),
            title: groupTitle(g.groupKey, g.lastTitle),
            workspace: workspace.name,
            meeting_count: g.meetings,
            last_started_at: g.lastStartedAt?.toISOString() ?? null,
          }) satisfies Output,
      );
    }),
  );
  return listed
    .flat()
    .toSorted((a, b) => (b.last_started_at ?? "").localeCompare(a.last_started_at ?? ""))
    .slice(0, limit);
}

async function digestOf(
  context: ToolContext,
  workspace: MeetingsWorkspace,
  groupKey: string,
  limit: number,
) {
  const meetings = meetingsOf(context, workspace);
  const [listed, digest, summarized] = await Promise.all([
    meetings.list({ groupKey, limit }),
    meetings.groupDigest(groupKey, limit),
    meetings.groupDigest(groupKey),
  ]);
  if (listed.status !== "ok" || digest.status !== "ok" || !listed.meetings.length) return null;
  const summaries = new Map(digest.meetings.map((m) => [m.id, m.summary]));
  const [latest] = listed.meetings;
  return {
    ...group(context.webAppURL, workspace, groupKey),
    title: groupTitle(groupKey, latest?.title ?? null),
    workspace: workspace.name,
    meeting_count: listed.meetings.length,
    last_started_at: latest?.startedAt.toISOString() ?? null,
    summary: summarized.status === "ok" ? (summarized.cached?.summary ?? null) : null,
    timeline: digest.meetings.flatMap((m) =>
      m.highlights.map((h) => ({
        meeting_id: m.id,
        started_at: m.startedAt.toISOString(),
        at: clock(h.atMs),
        text: h.text,
      })),
    ),
    meetings: listed.meetings.map((m) => ({
      id: m.id,
      title: m.title,
      url: meetingUrl(context.webAppURL, workspace, m.id),
      started_at: m.startedAt.toISOString(),
      summary: summaries.get(m.id) ?? null,
    })),
  } satisfies Output;
}

async function run(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const reached = await meetingsWorkspaces(context, input.workspace);
  if ("error" in reached) return toolError(reached.error);
  const key = input.group;
  if (!key) return result({ groups: await listGroups(context, reached.workspaces, input.limit) });
  const digests = await Promise.all(
    reached.workspaces.map((w) => digestOf(context, w, key, input.limit)),
  );
  const groups = digests.filter((d) => d !== null);
  if (!groups.length) {
    return toolError(
      "No meetings you can open in that group. Leave `group` out to list the groups, or use `meetings_search`.",
    );
  }
  return result({ groups });
}

export function registerMeetingsGroup(server: McpServer, context: ToolContext) {
  server.registerTool(
    "meetings_group",
    {
      title: "Read a group of meetings",
      description: `Meetings that belong together: a recurring meeting's series, or every call with one client (named by its domain). Without \`group\`, lists the groups the person has meetings in, newest first. With it, returns the group's digest: where things stand across its meetings, a timeline of their highlights, and its meetings, with ids for \`meetings_fetch\`. Only meetings the person can open count. ${THIRD_PARTY}`,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "meetings_group", () => run(context, input)),
  );
}
