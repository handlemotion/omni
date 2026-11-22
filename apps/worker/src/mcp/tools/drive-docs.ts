import type { McpServer } from "@modelcontextprotocol/server";
import { applyEdits, type EditResult } from "@omni/docs";
import {
  forMember,
  oauthClientName,
  schema,
  type StorageContext,
  type StoragePlace,
} from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "../../billing.ts";
import { createDoc, editDoc } from "../../storage/docs.ts";
import { driveFor, item, itemSchema } from "../drive.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const MAX_MARKDOWN = 200_000;
const SHOWN_ON_MISS = 20_000;

const markdown = z
  .string()
  .max(MAX_MARKDOWN)
  .describe(
    "The doc in Markdown: headings, lists, `- [ ]` to-dos, tables, code, quotes, links, images, and dropdowns as `<details><summary>Line</summary>` blocks.",
  );

const createInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Its title, without an extension (".md" is not needed).'),
  markdown,
  folder_id: z.string().min(1).optional().describe("A folder to put it in, from `drive_list`."),
  workspace: z.string().min(1).optional().describe("A workspace id, without `folder_id`."),
  space: z
    .enum(["my_files", "shared"])
    .default("my_files")
    .describe("Without `folder_id`: the person's My files (default), or the company's Shared."),
});

const editInput = z.object({
  id: z.string().min(1).describe("The doc's id, from `drive_search` or `drive_list`."),
  edits: z
    .array(
      z.object({
        find: z.string().min(1).describe("Markdown that occurs exactly once in the doc now."),
        replace: z.string().describe("What it becomes; empty deletes it."),
      }),
    )
    .min(1)
    .max(50)
    .optional()
    .describe("Changes made in order, each to the text the one before left: all or none."),
  markdown: markdown.optional().describe("The whole doc, new. Prefer `edits` for a change."),
});

const outputSchema = z.object({ doc: itemSchema });

type Writer = { files: ReturnType<typeof forMember>["storage"]; orgId: string; memberId: string };

const deps = async (context: ToolContext) => ({
  env: context.env,
  db: context.db,
  config: context.config,
  log: context.log,
  waitUntil: context.waitUntil,
  agent: await oauthClientName(context.db, context.caller.clientId),
});

async function writerIn(context: ToolContext, drive: StorageContext, orgId: string) {
  const member = (await drive.workspaces()).find((w) => w.id === orgId);
  if (!member) return null;
  const writer: Writer = {
    files: forMember(context.db, member.memberId).storage,
    orgId,
    memberId: member.memberId,
  };
  return writer;
}

const REFUSED: Record<string, string> = {
  forbidden: "The person may not change files there.",
  locked: "That doc is locked. Someone unlocks it in Omni first.",
  not_found: "No doc with that id you can change. Ids come from `drive_search` or `drive_list`.",
  not_a_doc: "That file is not a doc. Only Omni docs and Markdown files (.md) are docs.",
  too_large: "That doc is too large to change here.",
  too_large_after: "That change would make the doc larger than 1 MB. Nothing was changed.",
  full: "The workspace's storage is full.",
  invalid_name: "That name cannot be a file's name.",
  too_many_uploads: "Too many files are being written right now. Try again in a minute.",
  parent_trashed: "That folder is in the trash.",
};

const refusal = (reason: string) =>
  toolError(REFUSED[reason] ?? "Omni could not write the doc this time. Try again in a moment.");

async function placeFor(
  drive: StorageContext,
  input: z.infer<typeof createInput>,
  workspace: string | undefined,
) {
  if (input.folder_id) {
    const [folder] = await drive.read([input.folder_id]);
    if (!folder || folder.node.kind !== "folder" || folder.via !== "member") {
      return { error: "No folder with that id in your workspaces' drives. Use `drive_list`." };
    }
    const place: StoragePlace = { parentId: folder.node.id };
    return { place, orgId: folder.workspace.id };
  }
  const workspaces = await drive.workspaces();
  const chosen = workspace
    ? workspaces.find((w) => w.id === workspace)
    : workspaces.length === 1
      ? workspaces[0]
      : undefined;
  if (!chosen) {
    return {
      error: `Name a \`workspace\`: ${workspaces.map((w) => `${w.name} (${w.id})`).join(", ")}.`,
    };
  }
  if (input.space === "shared" && chosen.personal) {
    return { error: "A personal workspace has no Shared drive. Use `my_files`." };
  }
  const place: StoragePlace = { space: input.space === "shared" ? "shared" : "personal" };
  return { place, orgId: chosen.id };
}

async function audit(context: ToolContext, writer: Writer, subject: string, kind: string) {
  await context.db.insert(schema.auditEvents).values({
    orgId: writer.orgId,
    actorMemberId: writer.memberId,
    action: "mcp.drive_doc",
    subject,
    data: { via: "mcp", clientId: context.caller.clientId, kind },
  });
}

async function answer(context: ToolContext, drive: StorageContext, nodeId: string) {
  const [found] = await drive.read([nodeId]);
  if (!found) return toolError("The doc was written, but it could not be opened again.");
  return result({ doc: item(context.webAppURL, found) });
}

async function ready(context: ToolContext, orgId: string) {
  const wait = await context.rateLimit("actions");
  if (wait) return `Too many changes. Try again in ${wait} seconds.`;
  if (!(await inGoodStanding(context.db, context.config, orgId))) {
    return "This workspace is read-only until its plan is paid.";
  }
  return null;
}

async function create(context: ToolContext, input: z.infer<typeof createInput>) {
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const at = await placeFor(scoped.drive, input, scoped.workspace);
  if (!at.place) return toolError(at.error ?? "Name a folder or a workspace.");
  const writer = await writerIn(context, scoped.drive, at.orgId);
  if (!writer) return refusal("forbidden");
  const blocked = await ready(context, at.orgId);
  if (blocked) return toolError(blocked);
  const made = await createDoc(await deps(context), writer.files, at.orgId, {
    place: at.place,
    name: input.name,
    markdown: input.markdown,
  });
  if (made.status !== "ok") return refusal("reason" in made ? made.reason : made.status);
  await audit(context, writer, made.node.id, "create");
  return answer(context, scoped.drive, made.node.id);
}

async function edit(context: ToolContext, input: z.infer<typeof editInput>) {
  if (!input.edits === (input.markdown === undefined)) {
    return toolError("Give exactly one of `edits` or `markdown`.");
  }
  const scoped = driveFor(context, undefined);
  if ("error" in scoped) return toolError(scoped.error);
  const [found] = await scoped.drive.read([input.id]);
  if (!found || found.node.kind !== "file") return refusal("not_found");
  if (found.via !== "member") {
    return toolError("Only docs in your workspaces' drives can be changed here.");
  }
  const writer = await writerIn(context, scoped.drive, found.workspace.id);
  if (!writer) return refusal("forbidden");
  const blocked = await ready(context, found.workspace.id);
  if (blocked) return toolError(blocked);
  const change = (current: string) =>
    input.edits
      ? applyEdits(current, input.edits)
      : ({ ok: true, markdown: input.markdown ?? "" } satisfies EditResult);
  const edited = await editDoc(await deps(context), writer.files, input.id, change);
  if (edited.status === "invalid") {
    const shown = edited.markdown.slice(0, SHOWN_ON_MISS);
    const more = edited.markdown.length > shown.length ? "\n[…]" : "";
    return toolError(`${edited.error}\n\nThe doc reads now:\n\n${shown}${more}`);
  }
  if (edited.status !== "ok") return refusal("reason" in edited ? edited.reason : edited.status);
  await audit(context, writer, input.id, "edit");
  return answer(context, scoped.drive, input.id);
}

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerDriveDocs(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_create_doc",
    {
      title: "Write a doc",
      description:
        "Write a new doc in Drive from Markdown: in the person's My files by default, a company's Shared, or a folder. It opens in Omni as a page anyone with access can edit together. Returns the doc with its `url` to cite.",
      inputSchema: createInput,
      outputSchema,
      annotations: ANNOTATIONS,
    },
    (input) => guarded(context, "drive_create_doc", () => create(context, input)),
  );
  server.registerTool(
    "drive_edit_doc",
    {
      title: "Edit a doc",
      description:
        "Change a doc (an Omni doc, or a Markdown file) in Drive. Read it first with `drive_fetch`, then give `edits`: each `find` quotes Markdown that occurs exactly once and becomes `replace`. Edits apply to the doc as it is right now, including what people are typing in it, and appear live for anyone who has it open; earlier versions stay in its history. `markdown` replaces the whole doc instead.",
      inputSchema: editInput,
      outputSchema,
      annotations: ANNOTATIONS,
    },
    (input) => guarded(context, "drive_edit_doc", () => edit(context, input)),
  );
}
