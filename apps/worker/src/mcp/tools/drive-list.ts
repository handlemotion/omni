import type { McpServer } from "@modelcontextprotocol/server";
import type { StorageContext, StorageListCursor } from "@omni/db";
import { z } from "zod";
import { child, driveFor, item, itemSchema } from "../drive.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const SHARED_WITH_YOU = 20;

const inputSchema = z.object({
  folder_id: z.string().min(1).optional().describe("A folder id: list what is inside it."),
  workspace: z.string().min(1).optional().describe("One workspace id, with `space`."),
  space: z
    .enum(["my_files", "shared"])
    .optional()
    .describe("The top of a drive: the person's My files, or the company's Shared."),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional().describe("`next_cursor` from the last page."),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  folder: itemSchema.optional().describe("The folder listed."),
  items: z.array(itemSchema).describe("Folders first, then files, by name."),
  next_cursor: z.string().optional(),
  drives: z
    .array(
      z.object({
        workspace_id: z.string(),
        workspace: z.string(),
        space: z.enum(["my_files", "shared"]),
      }),
    )
    .optional()
    .describe("Without a folder or space: the drives to list."),
  shared_with_you: z
    .array(itemSchema)
    .optional()
    .describe("Without a folder or space: what others shared with the person, newest first."),
});

const encodeCursor = (cursor: StorageListCursor | null) => {
  if (!cursor) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify([cursor.kind, cursor.name, cursor.id]));
  return btoa(String.fromCharCode(...bytes));
};

const decodeCursor: (cursor: string | undefined) => StorageListCursor | null | undefined = (
  cursor,
) => {
  if (cursor === undefined) return undefined;
  try {
    const binary = atob(cursor);
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const [kind, name, id] = JSON.parse(json) as [string, string, string];
    if (
      (kind !== "file" && kind !== "folder") ||
      typeof name !== "string" ||
      typeof id !== "string"
    )
      return null;
    return { kind, name, id };
  } catch {
    return null;
  }
};

async function overview(context: ToolContext, drive: StorageContext) {
  const [workspaces, shared] = await Promise.all([
    drive.workspaces(),
    drive.sharedWithMe(SHARED_WITH_YOU),
  ]);
  const opened = await drive.read(shared.map((entry) => entry.node.id));
  return result({
    items: [],
    drives: workspaces.flatMap((w) => [
      { workspace_id: w.id, workspace: w.name, space: "my_files" as const },
      ...(w.personal ? [] : [{ workspace_id: w.id, workspace: w.name, space: "shared" as const }]),
    ]),
    shared_with_you: opened.map((found) => item(context.webAppURL, found)),
  });
}

async function list(context: ToolContext, input: Input) {
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const { drive } = scoped;
  const cursor = decodeCursor(input.cursor);
  if (cursor === null)
    return toolError("That cursor is not one `drive_list` returned. Start over without it.");
  const page = { cursor, limit: input.limit };

  if (input.folder_id) {
    const listed = await drive.listFolder(input.folder_id, page);
    if (!listed) {
      return toolError(
        "No folder with that id you can open. Ids come from `drive_search` or `drive_list`.",
      );
    }
    return result({
      folder: item(context.webAppURL, listed.folder),
      items: listed.nodes.map((node) => child(context.webAppURL, listed.folder, node)),
      ...(listed.nextCursor ? { next_cursor: encodeCursor(listed.nextCursor) } : {}),
    });
  }

  if (!input.space) return overview(context, drive);
  const workspaces = await drive.workspaces();
  const workspaceId = scoped.workspace ?? (workspaces.length === 1 ? workspaces[0]!.id : undefined);
  if (!workspaceId) {
    return toolError(
      `Name a \`workspace\` with \`space\`: ${workspaces.map((w) => `${w.name} (${w.id})`).join(", ")}.`,
    );
  }
  const listed = await drive.listDrive(
    workspaceId,
    input.space === "my_files" ? "personal" : "shared",
    page,
  );
  if (!listed)
    return toolError(
      "No such drive you can open. Call `drive_list` without arguments to see them.",
    );
  const parent = {
    role: "member" as const,
    via: "member" as const,
    workspace: listed.workspace,
    path: [],
    shareId: null,
  };
  return result({
    items: listed.nodes.map((node) => child(context.webAppURL, parent, node)),
    ...(listed.nextCursor ? { next_cursor: encodeCursor(listed.nextCursor) } : {}),
  });
}

export function registerDriveList(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_list",
    {
      title: "Browse Drive",
      description:
        "Browse Drive. Without arguments: the drives the person reaches (My files, and Shared in each company) and what others shared with them. With `workspace` and `space`: the top of that drive. With `folder_id`: what is inside that folder. Folders first, then files, by name, with `next_cursor` for more.",
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
