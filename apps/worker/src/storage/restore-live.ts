import { isDocFile, isOmniDoc } from "@omni/docs";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { s2Basin } from "../s2.ts";
import { announceDrives } from "./announce.ts";
import { wireNode } from "./core.ts";
import { LiveFile } from "./doc-live.ts";
import { DOC_MAX_BYTES, editDoc } from "./docs.ts";
import { memberStorage, refused } from "./http.ts";

const REFUSALS = new Set(["not_found", "forbidden", "locked", "full", "version_conflict"]);

/**
 * Restores a version of a doc people have open as an edit of its live document, so their pages
 * show it at once and nobody's next save is refused for it, and ends its session so the restored
 * page stays a version of its own. Null when the doc is not open live, or the version is not one
 * this can restore (too large for the live document, or no room for a new copy): the caller
 * restores the file itself.
 */
export async function restoreLive(c: Context<AppEnv>, nodeId: string, versionId: string) {
  const basin = s2Basin(c.var.config);
  if (!basin || c.var.shared) return null;
  const files = memberStorage(c);
  const [found, version] = await Promise.all([
    files.file(nodeId),
    files.versionFile(nodeId, versionId),
  ]);
  if (found.status !== "ok" || version.status !== "ok") return null;
  const node = found.file;
  if (!isDocFile(node.name, node.mimeType)) return null;
  if (isOmniDoc(version.file.mimeType) !== isOmniDoc(node.mimeType)) return null;
  if (Math.max(node.size, version.file.size) > DOC_MAX_BYTES) return null;
  if (!(await LiveFile.open(basin, nodeId, node.contentVersion))) return null;
  const object = await c.env.STORAGE_BUCKET.get(version.r2Key);
  if (!object) return null;
  const markdown = await object.text();
  const deps = {
    env: c.env,
    db: c.var.db,
    config: c.var.config,
    log: c.var.log,
    waitUntil: (work: Promise<unknown>) => c.executionCtx.waitUntil(work),
  };
  const by = `m:${c.var.member.id}`;
  const edited = await editDoc(deps, files, nodeId, () => ({ ok: true, markdown }), by);
  if (edited.status !== "ok") {
    const reason = "reason" in edited ? edited.reason : edited.status;
    if (reason === "full" || edited.status === "too_large_after") return null;
    return refused(c, (REFUSALS.has(reason) ? reason : "version_conflict") as "not_found");
  }
  await files.endSession(nodeId);
  announceDrives(c, [edited.node]);
  return c.json({ node: wireNode(edited.node) });
}
