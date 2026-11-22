import type { McpServer } from "@modelcontextprotocol/server";
import {
  applyCanvasOps,
  CANVAS_MAX_BYTES,
  canvasOpSchema,
  canvasOutline,
  limitProblem,
  sceneFromJson,
  tileFiles,
  type CanvasOp,
  type OpsResult,
  type Scene,
  type TileLookup,
} from "@omni/canvas";
import type { StorageContext } from "@omni/db";
import { z } from "zod";
import { createCanvas, editCanvas } from "../../storage/canvases.ts";
import { driveFor, item, itemSchema } from "../drive.ts";
import {
  audit,
  placeFor,
  placeInput,
  ready,
  writeDeps,
  writerIn,
  type Writer,
} from "../drive-write.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const MAX_OPS = 200;
const SHOWN_ON_MISS = 20_000;

const ops = z
  .array(canvasOpSchema)
  .min(1)
  .max(MAX_OPS)
  .describe(
    "Changes made in order, all or none. Add with `add` (sticky, shape, text, frame, or a Drive `file` tile) and place it with `at`, `place` next to another element, or nothing (to the right of everything, or inside its `parent` frame). Then `connect`, `arrange` as a row, column or grid, `group`, `frame`, `move`, `resize`, `update`, `order` and `delete`. New elements take a `ref` that later operations of the call use as their id.",
  );

const createInput = z.object({
  name: z.string().trim().min(1).max(200).describe("Its title, without an extension."),
  ops: ops.optional(),
  ...placeInput,
});

const editInput = z.object({
  id: z.string().min(1).describe("The canvas's id, from `drive_search` or `drive_list`."),
  ops: ops.optional(),
  scene: z
    .string()
    .max(CANVAS_MAX_BYTES)
    .optional()
    .describe(
      "The whole canvas, new: its JSON body as `drive_versions` shows it. Prefer `ops` for a change.",
    ),
});

const outputSchema = z.object({
  canvas: itemSchema,
  created: z.record(z.string(), z.string()).describe("The id each `ref` became."),
  changed: z
    .string()
    .describe("The outline lines of the elements changed or made, as `drive_fetch` shows them."),
  overlaps: z
    .array(z.tuple([z.string(), z.string()]))
    .describe("Pairs of elements whose boxes overlap now and did not before: a layout to fix."),
});

const REFUSED: Record<string, string> = {
  forbidden: "The person may not change files there.",
  locked: "That canvas is locked. Someone unlocks it in Omni first.",
  not_found: "No canvas with that id you can change. Ids come from `drive_search` or `drive_list`.",
  not_a_canvas: "That file is not a canvas. Use `drive_edit_doc` for docs.",
  too_large: "That canvas is too large to change here.",
  too_large_after: "That change would make the canvas larger than 400 KB. Nothing was changed.",
  full: "The workspace's storage is full.",
  invalid_name: "That name cannot be a file's name.",
  too_many_uploads: "Too many files are being written right now. Try again in a minute.",
  parent_trashed: "That folder is in the trash.",
};

const refusal = (reason: string) =>
  toolError(REFUSED[reason] ?? "Omni could not write the canvas this time. Try again in a moment.");

/** Which tiles' files the person can open, by id: their names and urls, for the outline. */
export async function tilesFor(context: ToolContext, drive: StorageContext, scene: Scene) {
  const ids = tileFiles(scene);
  const opened = ids.length ? await drive.read(ids) : [];
  const files = new Map(
    opened
      .filter((found) => found.node.kind === "file")
      .map((found) => [
        found.node.id,
        { name: found.node.name, url: item(context.webAppURL, found).url },
      ]),
  );
  const lookup: TileLookup = (id) => files.get(id) ?? null;
  return lookup;
}

async function unreachableFiles(drive: StorageContext, wanted: string[]) {
  if (!wanted.length) return [];
  const opened = await drive.read(wanted);
  const files = new Set(opened.filter((f) => f.node.kind === "file").map((f) => f.node.id));
  return wanted.filter((id) => !files.has(id));
}

const filesIn = (ops: CanvasOp[] | undefined) => [
  ...new Set((ops ?? []).flatMap((op) => (op.op === "add" && op.file_id ? [op.file_id] : []))),
];

async function answer(
  context: ToolContext,
  drive: StorageContext,
  nodeId: string,
  done: { scene: Scene; changed: Extract<OpsResult, { ok: true }> },
) {
  const [found] = await drive.read([nodeId]);
  if (!found) return toolError("The canvas was written, but it could not be opened again.");
  const tiles = await tilesFor(context, drive, done.scene);
  const changed = new Set(done.changed.changed);
  return result({
    canvas: item(context.webAppURL, found),
    created: done.changed.created,
    changed: canvasOutline(found.node.name, done.scene, tiles, changed),
    overlaps: done.changed.overlaps,
  });
}

const noFiles = (missing: string[]) =>
  toolError(
    `No Drive file you can open with the id ${missing.map((id) => `"${id}"`).join(", ")}. Find files with \`drive_search\`.`,
  );

async function create(context: ToolContext, input: z.infer<typeof createInput>) {
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const at = await placeFor(scoped.drive, input, scoped.workspace);
  if (!at.place) return toolError(at.error ?? "Name a folder or a workspace.");
  const writer = await writerIn(context, scoped.drive, at.orgId);
  if (!writer) return refusal("forbidden");
  const blocked = await ready(context, at.orgId);
  if (blocked) return toolError(blocked);
  const missing = await unreachableFiles(scoped.drive, filesIn(input.ops));
  if (missing.length) return noFiles(missing);
  const changed = applyCanvasOps({ elements: [] }, input.ops ?? []);
  if (!changed.ok) return toolError(changed.error);
  const made = await createCanvas(await writeDeps(context), writer.files, at.orgId, {
    place: at.place,
    name: input.name,
    scene: changed.scene,
  });
  if (made.status !== "ok") return refusal("reason" in made ? made.reason : made.status);
  await audit(context, writer, "mcp.drive_canvas", made.node.id, "create");
  return answer(context, scoped.drive, made.node.id, { scene: changed.scene, changed });
}

function replacedBy(current: Scene, whole: Scene, unreachable: Set<string>) {
  const before = new Map(current.elements.map((element) => [element.id, element]));
  const added = whole.elements.find(
    (element) =>
      element.file !== undefined &&
      unreachable.has(element.file) &&
      before.get(element.id)?.file !== element.file,
  );
  const changed = whole.elements
    .filter((element) => JSON.stringify(before.get(element.id)) !== JSON.stringify(element))
    .map((element) => element.id);
  const tooBig = limitProblem(current, whole);
  const replaced: OpsResult = added
    ? { ok: false, error: `No Drive file you can open with the id "${added.file}".` }
    : tooBig
      ? { ok: false, error: tooBig }
      : { ok: true, scene: whole, created: {}, changed, overlaps: [] };
  return replaced;
}

async function writable(context: ToolContext, drive: StorageContext, id: string) {
  const fail = (error: ReturnType<typeof toolError>) => ({ ok: false, error }) as const;
  const [found] = await drive.read([id]);
  if (!found || found.node.kind !== "file") return fail(refusal("not_found"));
  if (found.via !== "member") {
    return fail(toolError("Only canvases in your workspaces' drives can be changed here."));
  }
  const writer = await writerIn(context, drive, found.workspace.id);
  if (!writer) return fail(refusal("forbidden"));
  const blocked = await ready(context, found.workspace.id);
  if (blocked) return fail(toolError(blocked));
  return { ok: true, writer } as const;
}

async function edit(context: ToolContext, input: z.infer<typeof editInput>) {
  if (!input.ops === (input.scene === undefined)) {
    return toolError("Give exactly one of `ops` or `scene`.");
  }
  const whole = input.scene === undefined ? undefined : sceneFromJson(input.scene);
  if (whole && !whole.ok) return toolError(whole.error);
  const scoped = driveFor(context, undefined);
  if ("error" in scoped) return toolError(scoped.error);
  const opened = await writable(context, scoped.drive, input.id);
  if (!opened.ok) return opened.error;
  const writer: Writer = opened.writer;
  const missing = await unreachableFiles(scoped.drive, filesIn(input.ops));
  if (missing.length) return noFiles(missing);
  const unreachable = new Set(
    whole?.ok ? await unreachableFiles(scoped.drive, tileFiles(whole.scene)) : [],
  );
  const change = (current: Scene) =>
    whole?.ok ? replacedBy(current, whole.scene, unreachable) : applyCanvasOps(current, input.ops!);
  const deps = await writeDeps(context);
  const edited = await editCanvas(deps, writer.files, input.id, change);
  if (edited.status === "invalid") {
    const tiles = await tilesFor(context, scoped.drive, edited.scene);
    const outline = canvasOutline("", edited.scene, tiles).slice(0, SHOWN_ON_MISS);
    return toolError(`${edited.error}\n\nThe canvas is now:\n\n${outline}`);
  }
  if (edited.status === "unreadable")
    return toolError(`The canvas cannot be read: ${edited.error}`);
  if (edited.status !== "ok") return refusal("reason" in edited ? edited.reason : edited.status);
  await audit(context, writer, "mcp.drive_canvas", input.id, "edit");
  return answer(context, scoped.drive, input.id, edited);
}

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerDriveCanvas(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_create_canvas",
    {
      title: "Make a canvas",
      description:
        "Make a new canvas in Drive: a board of sticky notes, shapes, text, frames, connectors and tiles of other Drive files, which people edit together in Omni. In the person's My files by default, a company's Shared, or a folder. Build its content with `ops`. Returns the canvas's `url`, the id of each `ref`, the outline of what was made and any boxes that overlap.",
      inputSchema: createInput,
      outputSchema,
      annotations: ANNOTATIONS,
    },
    (input) => guarded(context, "drive_create_canvas", () => create(context, input)),
  );
  server.registerTool(
    "drive_edit_canvas",
    {
      title: "Edit a canvas",
      description:
        "Change a canvas in Drive. Read it first with `drive_fetch`: its outline lists each element's id, kind, colour, box `[x,y w×h]` and text. Give `ops`, which touch only what they name, apply to the canvas as it is right now (including what people are doing on it) and appear live for anyone who has it open; earlier versions stay in its history. `scene` replaces the whole board instead. The answer lists what changed and any boxes that now overlap.",
      inputSchema: editInput,
      outputSchema,
      annotations: ANNOTATIONS,
    },
    (input) => guarded(context, "drive_edit_canvas", () => edit(context, input)),
  );
}
