import type { McpServer } from "@modelcontextprotocol/server";
import type { StorageContext } from "@omni/db";
import {
  agentText,
  csvTab,
  evaluateDoc,
  layoutToken,
  rangeValues,
  readGrid,
  SHEET_LIMITS,
  type SheetEdit,
  type TabInput,
} from "@omni/sheets";
import { z } from "zod";
import { createSheet, editSheet, type OpenSheet } from "../../storage/sheets.ts";
import { driveFor, item, itemSchema } from "../drive.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";
import {
  audit as auditWrite,
  placeFor,
  placeInput,
  ready,
  writeDeps as deps,
  writerIn,
  type Writer,
} from "../drive-write.ts";

const SHOWN_ON_MISS = 20_000;

const value = z
  .union([z.string().max(SHEET_LIMITS.cellChars), z.number(), z.boolean(), z.null()])
  .describe(
    "A cell: text, a number, true/false, or null for empty. `=` starts a formula; `'=` is text.",
  );
const rows = z.array(z.array(value).max(SHEET_LIMITS.columns)).max(SHEET_LIMITS.rows);
const tab = z
  .string()
  .min(1)
  .max(100)
  .optional()
  .describe("The tab's name; the first tab by default.");
const cells = z.string().min(1).max(40);
const columnType = z.enum(["text", "number", "date", "checkbox", "select"]);
const format = z.object({
  kind: z.enum(["plain", "percent", "currency"]),
  decimals: z.number().int().min(0).max(10).optional(),
  currency: z.string().length(3).optional(),
});
const columnSpec = z.object({
  type: columnType.optional(),
  format: format.optional(),
  options: z.array(z.string().max(100)).max(100).optional(),
});

const createInput = z.object({
  name: z.string().trim().min(1).max(200).describe("Its title, without an extension."),
  tabs: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        rows: rows.describe("Rows of cells, top to bottom."),
        frozen_rows: z.number().int().min(0).max(100).optional().describe("Header rows to freeze."),
        columns: z
          .array(columnSpec.nullable())
          .max(SHEET_LIMITS.columns)
          .optional()
          .describe("Column types, A first; null for text."),
      }),
    )
    .min(1)
    .max(SHEET_LIMITS.tabs)
    .optional(),
  csv: z
    .string()
    .max(SHEET_LIMITS.bytes)
    .optional()
    .describe("One tab from CSV, instead of `tabs`."),
  ...placeInput,
});

const filterOp = z.enum([
  "contains",
  "is",
  "is_not",
  "empty",
  "not_empty",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "before",
  "after",
  "on",
  "any_of",
]);
const by = z
  .array(z.object({ column: z.string().min(1).max(3), desc: z.boolean().optional() }))
  .min(1)
  .max(3);

const editSchema = z.union([
  z.object({
    tab,
    set: cells.describe("A cell (B2) or range (A2:C3)."),
    value: value.optional(),
    values: rows.optional(),
  }),
  z.object({ tab, clear: cells }),
  z.object({ tab, append: rows.min(1).describe("Rows added after the last row with a value.") }),
  z.object({
    tab,
    insert_rows: z.object({
      before: z.number().int().min(1).optional(),
      after: z.number().int().min(0).optional(),
      count: z.number().int().min(1).max(1000).optional(),
    }),
  }),
  z.object({ tab, delete_rows: cells.describe("Rows, like 5 or 5:7.") }),
  z.object({
    tab,
    insert_columns: z.object({
      before: z.string().min(1).max(3).optional(),
      after: z.string().min(1).max(3).optional(),
      count: z.number().int().min(1).max(50).optional(),
    }),
  }),
  z.object({ tab, delete_columns: cells.describe("Columns, like C or C:D.") }),
  z.object({
    tab,
    column: z.string().min(1).max(3),
    type: columnType.optional(),
    format: format.optional(),
    options: z.array(z.string().max(100)).max(100).optional(),
    width: z.number().int().min(20).max(1000).optional(),
    time: z.boolean().optional(),
  }),
  z.object({
    tab,
    fill_down: cells.describe("Copies the range's first row down it, references relative."),
  }),
  z.object({ tab, sort: z.object({ range: cells.optional(), by }) }),
  z.object({ add_tab: z.string().trim().min(1).max(100) }),
  z.object({ tab, rename_tab: z.string().trim().min(1).max(100) }),
  z.object({ delete_tab: z.string().min(1).max(100) }),
  z.object({
    tab,
    freeze: z.object({
      rows: z.number().int().min(0).max(100).optional(),
      cols: z.number().int().min(0).max(26).optional(),
    }),
  }),
  z.object({
    tab,
    view: z.object({
      name: z.string().trim().min(1).max(100),
      filter: z
        .array(
          z.object({
            column: z.string().min(1).max(3),
            op: filterOp,
            value: z.union([value, z.array(value)]).optional(),
          }),
        )
        .max(10)
        .optional(),
      sort: by.optional(),
      hidden: z.array(z.string().min(1).max(3)).max(SHEET_LIMITS.columns).optional(),
    }),
  }),
]);

const editInput = z.object({
  id: z.string().min(1).describe("The sheet's id, from `drive_search` or `drive_list`."),
  layout: z
    .string()
    .optional()
    .describe("`layout` from `drive_fetch`: the edit is refused if rows or columns moved since."),
  edits: z
    .array(editSchema)
    .min(1)
    .max(SHEET_LIMITS.editsPerCall)
    .describe("Changes made in order, each to the sheet the one before left: all or none."),
});

const outputSchema = z.object({
  sheet: itemSchema,
  layout: z.string().describe("The sheet's layout now, for the next `drive_edit_sheet`."),
  changed: z.array(z.string()).optional().describe("The ranges this edit wrote, as `Tab!A1:C3`."),
  values: z.string().optional().describe("The changed cells' values now, formulas evaluated."),
});

const REFUSED: Record<string, string> = {
  forbidden: "The person may not change files there.",
  locked: "That sheet is locked. Someone unlocks it in Omni first.",
  not_found: "No sheet with that id you can change. Ids come from `drive_search` or `drive_list`.",
  not_a_sheet: "That file is not an Omni sheet. `drive_create_sheet` makes one.",
  unreadable: "That sheet's file could not be read.",
  too_large: "That sheet is too large to change here.",
  too_large_merged:
    "With what people typed meanwhile, the sheet is past a sheet's limits, so it was not saved. The change shows live for those editing it; undo part of it to save.",
  full: "The workspace's storage is full.",
  invalid_name: "That name cannot be a file's name.",
  too_many_uploads: "Too many files are being written right now. Try again in a minute.",
  parent_trashed: "That folder is in the trash.",
};

const refusal = (reason: string) =>
  toolError(REFUSED[reason] ?? "Omni could not write the sheet this time. Try again in a moment.");

const audit = (context: ToolContext, writer: Writer, subject: string, kind: string) =>
  auditWrite(context, writer, "mcp.drive_sheet", subject, kind);

function shownSheet(sheet: OpenSheet) {
  const text = agentText(evaluateDoc(sheet.doc));
  const shown = text.slice(0, SHOWN_ON_MISS);
  return `${shown}${text.length > shown.length ? "\n[…]" : ""}\n\nlayout: ${layoutToken(readGrid(sheet.doc))}`;
}

async function answer(
  context: ToolContext,
  drive: StorageContext,
  nodeId: string,
  extra: Record<string, unknown>,
) {
  const [found] = await drive.read([nodeId]);
  if (!found) return toolError("The sheet was written, but it could not be opened again.");
  return result({ sheet: item(context.webAppURL, found), ...extra });
}

async function create(context: ToolContext, input: z.infer<typeof createInput>) {
  if (!input.tabs === (input.csv === undefined))
    return toolError("Give exactly one of `tabs` or `csv`.");
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const at = await placeFor(scoped.drive, input, scoped.workspace);
  if (!at.place) return toolError(at.error ?? "Name a folder or a workspace.");
  const writer = await writerIn(context, scoped.drive, at.orgId);
  if (!writer) return refusal("forbidden");
  const blocked = await ready(context, at.orgId);
  if (blocked) return toolError(blocked);
  const tabs: TabInput[] = input.tabs ?? [csvTab("Sheet 1", input.csv ?? "")];
  const made = await createSheet(await deps(context), writer.files, at.orgId, {
    place: at.place,
    name: input.name,
    tabs,
  });
  if (made.status === "over_limits") return toolError(`That sheet would have ${made.problem}.`);
  if (made.status !== "ok") return refusal("reason" in made ? made.reason : made.status);
  await audit(context, writer, made.node.id, "create");
  return answer(context, scoped.drive, made.node.id, { layout: made.layout });
}

async function edit(context: ToolContext, input: z.infer<typeof editInput>) {
  const scoped = driveFor(context, undefined);
  if ("error" in scoped) return toolError(scoped.error);
  const [found] = await scoped.drive.read([input.id]);
  if (!found || found.node.kind !== "file") return refusal("not_found");
  if (found.via !== "member")
    return toolError("Only sheets in your workspaces' drives can be changed here.");
  const writer = await writerIn(context, scoped.drive, found.workspace.id);
  if (!writer) return refusal("forbidden");
  const blocked = await ready(context, found.workspace.id);
  if (blocked) return toolError(blocked);
  const writing = await deps(context);
  const edited = await editSheet(writing, writer.files, input.id, {
    edits: input.edits as SheetEdit[],
    by: `a:${writer.memberId}:${writing.agent}`,
    ...(input.layout ? { layout: input.layout } : {}),
  });
  if (edited.status === "stale") {
    return toolError(
      `Rows or columns moved since you read the sheet: read it again. It is now:\n\n${shownSheet(edited.sheet)}`,
    );
  }
  if (edited.status === "invalid") {
    return toolError(`${edited.error}\n\nThe sheet is now:\n\n${shownSheet(edited.sheet)}`);
  }
  if (edited.status === "over_limits") {
    return toolError(`The sheet would have ${edited.problem}. Nothing was changed.`);
  }
  if (edited.status !== "ok") return refusal("reason" in edited ? edited.reason : edited.status);
  await audit(context, writer, input.id, "edit");
  return answer(context, scoped.drive, input.id, {
    layout: layoutToken(edited.saved.grid),
    changed: edited.changed,
    values: rangeValues(edited.saved, edited.changed),
  });
}

const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerDriveSheets(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_create_sheet",
    {
      title: "Write a sheet",
      description:
        "Write a new Omni sheet in Drive: tabs of rows (or one tab from CSV), formulas as `=SUM(B2:B9)`, optional column types and frozen header rows. In the person's My files by default, a company's Shared, or a folder. It opens in Omni as a grid anyone with access can edit together. Returns the sheet with its `url` to cite.",
      inputSchema: createInput,
      outputSchema,
      annotations: ANNOTATIONS,
    },
    (input) => guarded(context, "drive_create_sheet", () => create(context, input)),
  );
  server.registerTool(
    "drive_edit_sheet",
    {
      title: "Edit a sheet",
      description:
        "Change an Omni sheet in Drive. Read it first with `drive_fetch` (rows by number, columns by letter), then give `edits` in A1: `set` a cell or range, `clear`, `append` rows, insert or delete rows and columns, a column's `type`, `fill_down`, `sort`, tabs, `freeze` and named `view`s. Pass `layout` from `drive_fetch` so the edit is refused if rows moved meanwhile. Edits apply to the sheet as it is now, including what people are typing, appear live for anyone who has it open, and answer the changed cells' values; earlier versions stay in its history.",
      inputSchema: editInput,
      outputSchema,
      annotations: ANNOTATIONS,
    },
    (input) => guarded(context, "drive_edit_sheet", () => edit(context, input)),
  );
}
