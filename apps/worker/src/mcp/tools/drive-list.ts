import type { McpServer } from "@modelcontextprotocol/server";
import type { StorageContext, StorageListCursor } from "@omni/db";
import { z } from "zod";
import { child, driveFor, item, itemSchema, type Item } from "../drive.ts";
import { result, toolError } from "../format.ts";
import { encodeCursor, readCursor } from "../../cursor.ts";
import { guarded, type ToolContext } from "../server.ts";

const SHARED_WITH_YOU = 20;
const MAX_DEPTH = 4;
const MAX_TREE = 300;

const inputSchema = z.object({
  folder_id: z.string().min(1).optional().describe("A folder id: list what is inside it."),
  workspace: z.string().min(1).optional().describe("One workspace id: look only there."),
  teamspace_id: z
    .string()
    .min(1)
    .optional()
    .describe("A teamspace id from `drives`: list the top of that teamspace."),
  limit: z.number().int().min(1).max(100).default(50),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .default(1)
    .describe(
      `With \`folder_id\`: also list inside its folders, this many levels down (up to ${MAX_DEPTH}, ${MAX_TREE} items in all), each item's \`location\` saying where it is.`,
    ),
  cursor: z.string().optional().describe("`next_cursor` from the last page."),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  folder: itemSchema.optional().describe("The folder listed."),
  cut: z
    .boolean()
    .optional()
    .describe("With `depth`: the tree has more than was listed. List a folder in it for the rest."),
  items: z.array(itemSchema).describe("Folders first, then files, by name."),
  next_cursor: z.string().optional(),
  drives: z
    .array(
      z.object({
        workspace_id: z.string(),
        workspace: z.string(),
        space: z.literal("teamspace"),
        teamspace_id: z.string().optional(),
        teamspace: z.string().optional().describe("The teamspace's name."),
      }),
    )
    .optional()
    .describe("Without a folder or teamspace: the teamspaces to list."),
  shared_with_you: z
    .array(itemSchema)
    .optional()
    .describe("Without a folder or teamspace: what others shared with the person, newest first."),
});

const cursorSchema = z
  .tuple([z.enum(["file", "folder"]), z.string(), z.string()])
  .transform(([kind, name, id]) => ({ kind, name, id }) satisfies StorageListCursor);

const nextCursor = (cursor: StorageListCursor | null) =>
  cursor ? { next_cursor: encodeCursor([cursor.kind, cursor.name, cursor.id]) ?? "" } : {};

async function overview(context: ToolContext, drive: StorageContext) {
  const [workspaces, shared, teamspaces] = await Promise.all([
    drive.workspaces(),
    drive.sharedWithMe(SHARED_WITH_YOU),
    drive.teamspaces(),
  ]);
  const opened = await drive.read(shared.map((entry) => entry.node.id));
  return result({
    items: [],
    drives: workspaces.flatMap((w) =>
      teamspaces
        .filter((t) => t.orgId === w.id)
        .map((t) => ({
          workspace_id: w.id,
          workspace: w.name,
          space: "teamspace" as const,
          teamspace_id: t.id,
          teamspace: t.name,
        })),
    ),
    shared_with_you: opened.map((found) => item(context.webAppURL, found)),
  });
}

async function list(context: ToolContext, input: Input) {
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const { drive } = scoped;
  const read = input.cursor === undefined ? undefined : readCursor(input.cursor, cursorSchema);
  if (read === null)
    return toolError("That cursor is not one `drive_list` returned. Start over without it.");
  const page = { cursor: read?.cursor, limit: input.limit };

  if (input.folder_id) {
    const listed = await drive.listFolder(input.folder_id, page);
    if (!listed) {
      return toolError(
        "No folder with that id you can open. Ids come from `drive_search` or `drive_list`.",
      );
    }
    if (input.depth > 1 && !read) return tree(context, drive, listed, input);
    return result({
      folder: item(context.webAppURL, listed.folder),
      items: listed.nodes.map((node) => child(context.webAppURL, listed.folder, node)),
      ...nextCursor(listed.nextCursor),
    });
  }

  if (input.teamspace_id) {
    const teamspace = (await drive.teamspaces()).find((t) => t.id === input.teamspace_id);
    if (!teamspace) {
      return toolError("No teamspace with that id you can open. Ids come from `drive_list`.");
    }
    const listed = await drive.listDrive(teamspace.orgId, { teamspaceId: teamspace.id }, page);
    if (!listed) return toolError("That teamspace could not be listed.");
    return topOf(context, listed);
  }

  return overview(context, drive);
}

type Listed = NonNullable<Awaited<ReturnType<StorageContext["listFolder"]>>>;

async function tree(context: ToolContext, drive: StorageContext, top: Listed, input: Input) {
  const items: Item[] = [];
  let cut = top.nextCursor !== null;
  let level: Listed[] = [top];
  for (let depth = 1; depth <= input.depth && level.length; depth++) {
    const next: Listed[] = [];
    for (const listed of level) {
      for (const node of listed.nodes) {
        if (items.length >= MAX_TREE) {
          cut = true;
          break;
        }
        items.push(child(context.webAppURL, listed.folder, node));
        if (node.kind !== "folder" || depth === input.depth) continue;
        const inside = await drive.listFolder(node.id, { limit: input.limit });
        if (!inside) continue;
        cut ||= inside.nextCursor !== null;
        next.push(inside);
      }
    }
    level = next;
  }
  return result({
    folder: item(context.webAppURL, top.folder),
    items,
    ...(cut ? { cut: true } : {}),
  });
}

function topOf(
  context: ToolContext,
  listed: NonNullable<Awaited<ReturnType<StorageContext["listDrive"]>>>,
) {
  const parent = {
    role: "member" as const,
    via: "member" as const,
    workspace: listed.workspace,
    path: [],
    shareId: null,
  };
  return result({
    items: listed.nodes.map((node) => child(context.webAppURL, parent, node)),
    ...nextCursor(listed.nextCursor),
  });
}

export function registerDriveList(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_list",
    {
      title: "Browse Drive",
      description:
        "Browse Drive. Without arguments: the teamspaces the person reaches in each workspace and what others shared with them. With `teamspace_id`: the top of that teamspace. With `folder_id`: what is inside that folder. Folders first, then files, by name, with `next_cursor` for more.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "drive_list", () => list(context, input)),
  );
}
