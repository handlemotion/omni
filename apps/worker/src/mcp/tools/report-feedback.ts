import type { McpServer } from "@modelcontextprotocol/server";
import { schema } from "@omni/db";
import { z } from "zod";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const KINDS = ["bug", "wrong_result", "confusing", "missing", "slow", "other"] as const;

const inputSchema = z.object({
  kind: z
    .enum(KINDS)
    .describe(
      "bug: an error or failure. wrong_result: an answer that contradicts the tool's description or another tool. confusing: a description, parameter or error that misled you. missing: something no tool can do. slow: a call that held up the answer.",
    ),
  summary: z.string().trim().min(1).max(200).describe("One line: the problem itself."),
  details: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .describe(
      "What you called (tool, argument names, the shape of the values), what you expected, what you got, and any error text word for word.",
    ),
  proposed_fix: z
    .string()
    .trim()
    .min(1)
    .max(5_000)
    .optional()
    .describe("The change you would make to the tool, its description or its schema."),
  tool: z.string().trim().min(1).max(64).optional().describe("The tool it is about."),
});

const outputSchema = z.object({ feedback_id: z.string() });

type Report = z.infer<typeof inputSchema>;

async function announce(context: ToolContext, id: string, input: Report) {
  const url = context.config.MCP_FEEDBACK_WEBHOOK_URL;
  if (!url) return;
  const about = input.tool ? `, ${input.tool}` : "";
  const text = [
    `*Agent feedback* (${input.kind}${about}): ${input.summary}`,
    input.details,
    ...(input.proposed_fix ? [`*Proposed fix:* ${input.proposed_fix}`] : []),
    `_${id} · client ${context.caller.clientId}_`,
  ].join("\n\n");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) context.log.warn("mcp.feedback_webhook", { status: response.status });
  } catch (error) {
    context.log.warn("mcp.feedback_webhook", { error });
  }
}

async function report(context: ToolContext, input: Report) {
  const wait = await context.rateLimit("feedback");
  if (wait) return toolError(`Too much feedback at once. Try again in ${wait} seconds.`);
  const [row] = await context.db
    .insert(schema.agentFeedback)
    .values({
      userId: context.caller.userId,
      clientId: context.caller.clientId,
      kind: input.kind,
      tool: input.tool ?? null,
      summary: input.summary,
      details: input.details,
      proposedFix: input.proposed_fix ?? null,
    })
    .returning({ id: schema.agentFeedback.id });
  const id = row!.id;
  context.waitUntil(announce(context, id, input));
  return result({ feedback_id: id });
}

export function registerReportFeedback(server: McpServer, context: ToolContext) {
  server.registerTool(
    "report_feedback",
    {
      title: "Report feedback on Wok's tools",
      description:
        "Tell the people who build Wok about a problem with its tools: one that errored, answered wrongly, misled you, was slow, or could not do what the person asked. Report once per problem, after finishing the person's task. Write what you called, what you expected and got, and the fix you would make. Describe the person's data by its shape (ids are fine); keep message text, names, addresses and file contents out. The skill skill://report-feedback/SKILL.md has the details.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "report_feedback", () => report(context, input)),
  );
}
