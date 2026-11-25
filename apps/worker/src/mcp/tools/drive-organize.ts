import type { McpServer } from "@modelcontextprotocol/server";
import { type StorageContext, type StorageNode, type StoragePlace } from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "../../billing.ts";
import { announceTo, type Touched } from "../../storage/announce.ts";
import { driveFor, item, itemSchema } from "../drive.ts";
import { writerIn, type Writer } from "../drive-write.ts";
import { result, toolError } from "../format.ts";
import { guarded, recordMcpWrite, type ToolContext } from "../server.ts";

const MAX_CHANGES = 50;

const ACTIONS = ["create_folder", "move", "rename", "trash", "restore"] as const;

const changeSchema = z.object({
  action: z
    .enum(ACTIONS)
    .describe(
      "`create_folder` (name, and folder_id or teamspace_id), `move` (id, and folder_id or teamspace_id), `rename` (id, name), `trash` (id), `restore` (id, from the trash).",
    ),
  id: z
    .string()
    .min(1)
    .optional()
    .describe("The file or folder to change, or a `ref` made earlier in this call."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe("A new folder's name, or the new name."),
  folder_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Where it goes: a folder id from `drive_list`, or a `ref` made earlier in this call.",
    ),
  teamspace_id: z.string().min(1).optional().describe("Where it goes: the top of this teamspace."),
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("`create_folder` only: a name for the new folder that later changes use as its id."),
});

type Change = z.infer<typeof changeSchema>;

const inputSchema = z.object({
  changes: z.array(changeSchema).min(1).max(MAX_CHANGES),
});

const outputSchema = z.object({
  results: z.array(
    z.object({
      action: z.enum(ACTIONS),
      ok: z.boolean(),
      id: z.string().optional().describe("The id it had, for a change that answers no item."),
      item: itemSchema.optional().describe("The file or folder as it is now."),
      ref: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

type Outcome = z.infer<typeof outputSchema>["results"][number];

const REFUSED: Record<string, string> = {
  not_found:
    "No file or folder with that id you can change. Ids come from `drive_search` or `drive_list`.",
  forbidden: "The person may not change that.",
  invalid_name: "That name cannot be a file's name.",
  name_taken: "Something there already has that name.",
  too_deep: "Folders cannot nest that deep.",
  cycle: "A folder cannot move into itself.",
  parent_trashed: "The folder it was in is in the trash: restore that one first.",
  locked: "It is locked. Someone unlocks it in Wok first.",
  version_conflict: "It changed while this ran. Read it again and retry.",
};

const refusal = (status: string) => REFUSED[status] ?? "Wok could not make this change.";

interface Run {
  context: ToolContext;
  drive: StorageContext;
  refs: Map<string, string>;
  touched: Touched[];
  standing: Map<string, boolean>;
}

async function writerFor(run: Run, orgId: string) {
  const writer = await writerIn(run.context, run.drive, orgId);
  if (!run.standing.has(orgId)) {
    run.standing.set(orgId, await inGoodStanding(run.context.db, run.context.config, orgId));
  }
  const unpaid = "This workspace is read-only until its plan is paid.";
  const found: Writer | string = !writer
    ? refusal("forbidden")
    : run.standing.get(orgId)
      ? writer
      : unpaid;
  return found;
}

async function memberNode(run: Run, id: string | undefined) {
  if (!id) return "Name the `id` to change.";
  const [found] = await run.drive.read([run.refs.get(id) ?? id]);
  if (!found) return refusal("not_found");
  if (found.via !== "member") return "Only files in your workspaces' drives can be changed here.";
  return found;
}

async function placeOf(run: Run, change: Change) {
  if (change.folder_id) {
    const [folder] = await run.drive.read([run.refs.get(change.folder_id) ?? change.folder_id]);
    if (!folder || folder.node.kind !== "folder" || folder.via !== "member") {
      return "No folder with that `folder_id` in your workspaces' drives. Use `drive_list`.";
    }
    return { place: { parentId: folder.node.id } as StoragePlace, orgId: folder.workspace.id };
  }
  const teamspace = change.teamspace_id
    ? (await run.drive.teamspaces()).find((t) => t.id === change.teamspace_id)
    : undefined;
  if (!teamspace) return "Name a `folder_id`, or a `teamspace_id` from `drive_list`.";
  return { place: { teamspaceId: teamspace.id } as StoragePlace, orgId: teamspace.orgId };
}

async function answer(run: Run, change: Change, node: StorageNode, writer: Writer) {
  await recordMcpWrite(run.context, writer, "mcp.drive_organize", node.id, {
    action: change.action,
  });
  const [found] = await run.drive.read([node.id]);
  return {
    action: change.action,
    ok: true,
    ...(found ? { item: item(run.context.webAppURL, found) } : {}),
  } satisfies Outcome;
}

async function createFolder(run: Run, change: Change) {
  if (!change.name) return "Give the new folder a `name`.";
  if (change.ref && run.refs.has(change.ref)) return "That `ref` is already used in this call.";
  const at = await placeOf(run, change);
  if (typeof at === "string") return at;
  const writer = await writerFor(run, at.orgId);
  if (typeof writer === "string") return writer;
  const made = await writer.files.createFolder(at.place, change.name);
  if (made.status !== "ok") return refusal(made.status);
  if (change.ref) run.refs.set(change.ref, made.node.id);
  run.touched.push(made.node);
  const done = await answer(run, change, made.node, writer);
  return change.ref ? { ...done, ref: change.ref } : done;
}

async function move(run: Run, change: Change) {
  const found = await memberNode(run, change.id);
  if (typeof found === "string") return found;
  const at = await placeOf(run, change);
  if (typeof at === "string") return at;
  if (at.orgId !== found.workspace.id) return "Files move only within their own workspace.";
  const writer = await writerFor(run, at.orgId);
  if (typeof writer === "string") return writer;
  const moved = await writer.files.move(found.node.id, at.place);
  if (moved.status !== "ok") return refusal(moved.status);
  const { orgId, space, ownerMemberId, teamspaceId } = moved.left ?? moved.node;
  run.touched.push(moved.node, {
    orgId,
    space,
    ownerMemberId,
    teamspaceId,
    parentId: moved.fromParentId,
  });
  return answer(run, change, moved.node, writer);
}

async function rename(run: Run, change: Change) {
  if (!change.name) return "Give the new `name`.";
  const found = await memberNode(run, change.id);
  if (typeof found === "string") return found;
  const writer = await writerFor(run, found.workspace.id);
  if (typeof writer === "string") return writer;
  const renamed = await writer.files.rename(found.node.id, change.name);
  if (renamed.status !== "ok") return refusal(renamed.status);
  run.touched.push(renamed.node);
  return answer(run, change, renamed.node, writer);
}

async function trash(run: Run, change: Change) {
  const found = await memberNode(run, change.id);
  if (typeof found === "string") return found;
  const writer = await writerFor(run, found.workspace.id);
  if (typeof writer === "string") return writer;
  const trashed = await writer.files.trash(found.node.id);
  if (trashed.status !== "ok") return refusal(trashed.status);
  run.touched.push(trashed.node);
  await recordMcpWrite(run.context, writer, "mcp.drive_organize", found.node.id, {
    action: "trash",
  });
  return { action: change.action, ok: true, id: found.node.id } satisfies Outcome;
}

async function restore(run: Run, change: Change) {
  if (!change.id) return "Name the `id` to restore.";
  let blocked: string | null = null;
  for (const workspace of await run.drive.workspaces()) {
    const writer = await writerFor(run, workspace.id);
    if (typeof writer === "string") {
      blocked = writer;
      continue;
    }
    const restored = await writer.files.restore(change.id);
    if (restored.status === "not_found") continue;
    if (restored.status !== "ok") return refusal(restored.status);
    run.touched.push(restored.node);
    return answer(run, change, restored.node, writer);
  }
  return blocked ?? "Nothing in the trash with that id you can restore.";
}

const RUN = { create_folder: createFolder, move, rename, trash, restore } as const;

async function organize(context: ToolContext, input: z.infer<typeof inputSchema>) {
  const wait = await context.rateLimit("actions", input.changes.length);
  if (wait) return toolError(`Too many changes. Try again in ${wait} seconds.`);
  const scoped = driveFor(context, undefined);
  if ("error" in scoped) return toolError(scoped.error);
  const run: Run = {
    context,
    drive: scoped.drive,
    refs: new Map(),
    touched: [],
    standing: new Map(),
  };
  const results: Outcome[] = [];
  for (const change of input.changes) {
    const done = await RUN[change.action](run, change);
    results.push(
      typeof done === "string" ? { action: change.action, ok: false, error: done } : done,
    );
  }
  announceTo(context, run.touched);
  return result({ results });
}

export function registerDriveOrganize(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_organize",
    {
      title: "Organize Drive",
      description:
        "Make folders and move, rename, trash or restore files and folders in Drive, up to 50 changes a call, applied in order. A new folder may carry a `ref` that later changes in the same call use as its id, so one call can build a whole tree and file things into it. Each change answers on its own: one that fails leaves the others. Trash is reversible with `restore` for 30 days; nothing is deleted for good.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "drive_organize", () => organize(context, input)),
  );
}
