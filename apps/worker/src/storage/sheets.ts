import type { MemberStorage, StorageNode, StoragePlace } from "@omni/db";
import {
  applySheetEdits,
  createSheetFile,
  isOmniSheet,
  layoutToken,
  limitProblem,
  nowSerial,
  parseSheet,
  readGrid,
  saveSheet,
  serializeSheet,
  sheetDoc,
  SHEET_LIMITS,
  SHEET_TYPE,
  type SheetEdit,
  type TabInput,
} from "@omni/sheets";
import * as Y from "yjs";
import { s2Basin } from "../s2.ts";
import { LiveFile } from "./doc-live.ts";
import { refusalFor, writeText, type WriteDeps } from "./doc-write.ts";
import { passOn, saveLive } from "./docs.ts";

/** A sheet as it is now: its live document (with unsaved typing) when open, else its file's. */
export interface OpenSheet {
  node: StorageNode;
  doc: Y.Doc;
  live: LiveFile | null;
}

async function bodyOf(bucket: R2Bucket, r2Key: string) {
  const object = await bucket.get(r2Key);
  return object ? await object.text() : "";
}

/**
 * Opens a sheet through the member's door: refused, or the sheet as people see it now. With
 * `savedIfLiveFails`, a live layer that cannot be read leaves the sheet as its file saved it.
 */
export async function openSheet(
  deps: Pick<WriteDeps, "env" | "config">,
  files: MemberStorage,
  nodeId: string,
  savedIfLiveFails = false,
) {
  const found = await files.file(nodeId);
  if (found.status !== "ok") return { status: found.status } as const;
  const node = found.file;
  if (!isOmniSheet(node.mimeType)) return { status: "not_a_sheet" } as const;
  if (node.size > SHEET_LIMITS.bytes) return { status: "too_large" } as const;
  const basin = s2Basin(deps.config);
  const opening = basin ? LiveFile.open(basin, nodeId, node.contentVersion) : null;
  const live = (savedIfLiveFails ? await opening?.catch(() => null) : await opening) ?? null;
  let doc = live?.doc;
  if (!doc) {
    try {
      doc = sheetDoc(parseSheet(await bodyOf(deps.env.STORAGE_BUCKET, found.r2Key)));
    } catch {
      return { status: "unreadable" } as const;
    }
  }
  return { status: "ok", sheet: { node, doc, live } satisfies OpenSheet } as const;
}

/** A new sheet at `place` from tabs of rows, its formulas evaluated. */
export async function createSheet(
  deps: WriteDeps,
  files: MemberStorage,
  orgId: string,
  input: { place: StoragePlace; name: string; tabs: TabInput[] },
) {
  const file = createSheetFile(input.tabs);
  const problem = limitProblem(file);
  if (problem) return { status: "over_limits", problem } as const;
  const saved = saveSheet(sheetDoc(file), nowSerial());
  if (new TextEncoder().encode(saved.text).byteLength > SHEET_LIMITS.bytes) {
    return { status: "over_limits", problem: "a file larger than 5 MB" } as const;
  }
  const place = { place: input.place, name: input.name.trim() };
  const written = await writeText(deps, files, orgId, place, saved.text, SHEET_TYPE);
  return written.status === "ok" ? { ...written, layout: layoutToken(saved.grid) } : written;
}

function savedWithin(doc: Y.Doc, now: number) {
  const saved = saveSheet(doc, now);
  const problem =
    limitProblem(saved.file) ??
    (new TextEncoder().encode(saved.text).byteLength > SHEET_LIMITS.bytes
      ? "a file larger than 5 MB"
      : null);
  return problem ? ({ problem } as const) : ({ saved } as const);
}

/**
 * Applies `edits` to a sheet as it is now. While people edit it live the change goes into their
 * live document, merged with what they type, and is saved from there; otherwise it is the file's
 * next version. `layout`, when given, must still be the sheet's: rows and columns did not move.
 */
export async function editSheet(
  deps: WriteDeps,
  files: MemberStorage,
  nodeId: string,
  input: { edits: SheetEdit[]; layout?: string; by?: string },
) {
  const opened = await openSheet(deps, files, nodeId);
  if (opened.status !== "ok") return opened;
  const { node, doc, live } = opened.sheet;
  if (node.lockedAt) return { status: "locked" } as const;
  const writable = await files.mayWrite(nodeId);
  if (writable !== "ok") return { status: writable } as const;
  if (input.layout && input.layout !== layoutToken(readGrid(doc))) {
    return { status: "stale", sheet: opened.sheet } as const;
  }
  const now = nowSerial();
  const outcome = applySheetEdits(doc, input.edits, now);
  if (!outcome.ok) return { status: "invalid", error: outcome.error, sheet: opened.sheet } as const;
  const within = savedWithin(doc, now);
  if ("problem" in within) return { status: "over_limits", problem: within.problem } as const;
  const { saved } = within;
  const done = { changed: outcome.changed, saved };
  const target = { nodeId, ifContentVersion: node.contentVersion };
  if (!live) {
    const written = await writeText(deps, files, node.orgId, target, saved.text, node.mimeType);
    return written.status === "ok" ? { ...written, ...done } : written;
  }
  const refused = await refusalFor(deps, files, node.orgId, target, saved.text, node.mimeType);
  if (refused && refused.status !== "ok") return refused;
  await live.lastFold();
  const merged = savedWithin(live.doc, now);
  if ("problem" in merged) return { status: "over_limits", problem: merged.problem } as const;
  await files.endSession(nodeId);
  const { entries, through, mine } = await live.append(outcome.update, input.by);
  passOn(deps, node.orgId, nodeId, entries);
  const written = await saveLive(
    deps,
    files,
    { nodeId, orgId: node.orgId, base: node.contentVersion, mimeType: node.mimeType },
    live,
    { through, mine },
    () => savedWithin(live.doc, now).saved?.text ?? null,
  );
  return written.status === "ok"
    ? { ...written, ...done, saved: saveSheet(live.doc, now) }
    : written;
}

export { serializeSheet };
