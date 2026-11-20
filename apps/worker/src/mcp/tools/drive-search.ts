import type { McpServer } from "@modelcontextprotocol/server";
import { STORAGE_CONTEXT_SEARCH_MAX } from "@omni/db";
import { z } from "zod";
import { searchDrive } from "../../storage/meaning.ts";
import { driveFor, item, itemSchema } from "../drive.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const inputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'Words to find in file names and in the text inside files (PDFs, Word, PowerPoint, Excel, text and code, and the words in pictures and scans). Web search syntax: "exact phrase", -exclude, or.',
    ),
  workspace: z.string().min(1).optional().describe("One workspace id."),
  limit: z.number().int().min(1).max(STORAGE_CONTEXT_SEARCH_MAX).default(10),
});

const outputSchema = z.object({
  results: z.array(
    itemSchema.extend({
      snippet: z
        .string()
        .describe(
          "Where the words appear in the file's text, marked **like this**; for a `meaning` match, the start of its text; empty when only the name matched.",
        ),
      match: z
        .enum(["words", "meaning"])
        .describe(
          "`words`: the name or text holds the query's words. `meaning`: it holds none of them but is about what the query asks for (other wording, another language).",
        ),
    }),
  ),
});

async function find(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const wait = await context.rateLimit("search");
  if (wait) return toolError(`Too many searches. Try again in ${wait} seconds.`);
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const { hits, ranking } = await searchDrive(scoped.drive, context.config, input.query, {
    limit: input.limit,
    workspace: scoped.workspace,
    log: context.log,
  });
  context.log.info("drive.search", { ranking, results: hits.length });
  return result({
    results: hits.map((hit) => ({
      ...item(context.webAppURL, hit),
      snippet: hit.snippet,
      match: hit.match,
    })),
  });
}

export function registerDriveSearch(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_search",
    {
      title: "Search Drive",
      description:
        "Find files and folders in Drive by name, by the text inside them, and by what they are about: the person's My files, their companies' Shared drives, and what others shared with them. Ask in plain words, in any language; a file can match by meaning without sharing a word with the query. Best matches first. Returns ids to pass to `drive_fetch`, which reads up to 10 files' text at once.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "drive_search", () => find(context, input)),
  );
}
