import type { StorageLiveEntry } from "@omni/contracts";
import { DOC_TYPE, isDocFile, type EditResult } from "@omni/docs";
import type { MemberStorage, StoragePlace } from "@omni/db";
import { s2Basin } from "../s2.ts";
import { docRecordEvents, LiveFile } from "./doc-live.ts";
import { refusalFor, writeText, type WriteDeps, type WriteResult } from "./doc-write.ts";
import { journalLater } from "./journal.ts";

/** The largest doc an agent may change: what the editor opens whole. */
export const DOC_MAX_BYTES = 1_000_000;

const SAVE_TRIES = 3;

async function readText(bucket: R2Bucket, r2Key: string) {
  const object = await bucket.get(r2Key);
  return object ? await object.text() : "";
}

/** Passes `entries` on to everyone editing the file, through the workspace's realtime object. */
export function passOn(
  deps: WriteDeps,
  orgId: string,
  nodeId: string,
  entries: StorageLiveEntry[],
) {
  const stub = deps.env.REALTIME.get(deps.env.REALTIME.idFromName(orgId));
  deps.waitUntil(
    stub
      .docRecords(nodeId, docRecordEvents(nodeId, entries))
      .catch((error: unknown) => deps.log.warn("storage.doc_pass_on_failed", { error })),
  );
}

/** A new doc at `place`, holding `markdown`. */
export function createDoc(
  deps: WriteDeps,
  files: MemberStorage,
  orgId: string,
  input: { place: StoragePlace; name: string; markdown: string },
) {
  return writeText(
    deps,
    files,
    orgId,
    { place: input.place, name: input.name.trim() },
    input.markdown,
    DOC_TYPE,
  );
}

/**
 * Changes a doc's Markdown with `change`. While people edit it live the change goes into their
 * live document, merged with what they type, and is saved from there; otherwise it is the file's
 * next version. Either way it is made on the doc as it is now, unsaved typing included.
 */
export async function editDoc(
  deps: WriteDeps,
  files: MemberStorage,
  nodeId: string,
  change: (markdown: string) => EditResult,
  by?: string,
) {
  const found = await files.file(nodeId);
  if (found.status !== "ok") return found;
  const node = found.file;
  if (!isDocFile(node.name, node.mimeType)) return { status: "not_a_doc" } as const;
  if (node.lockedAt) return { status: "locked" } as const;
  if (node.size > DOC_MAX_BYTES) return { status: "too_large" } as const;
  const writable = await files.mayWrite(nodeId);
  if (writable !== "ok") return { status: writable } as const;
  const basin = s2Basin(deps.config);
  const live = basin ? await LiveFile.open(basin, nodeId, node.contentVersion) : null;
  const before = live ? live.markdown : await readText(deps.env.STORAGE_BUCKET, found.r2Key);
  const changed = change(before);
  if (!changed.ok) return { status: "invalid", error: changed.error, markdown: before } as const;
  if (new TextEncoder().encode(changed.markdown).byteLength > DOC_MAX_BYTES) {
    return { status: "too_large_after" } as const;
  }
  if (!live) {
    return writeText(
      deps,
      files,
      node.orgId,
      { nodeId, ifContentVersion: node.contentVersion },
      changed.markdown,
      node.mimeType,
    );
  }
  const target = { nodeId, ifContentVersion: node.contentVersion };
  const refused = await refusalFor(
    deps,
    files,
    node.orgId,
    target,
    changed.markdown,
    node.mimeType,
  );
  if (refused) return refused;
  await files.endSession(nodeId);
  const { entry, through } = await live.rewrite(changed.markdown, by);
  passOn(deps, node.orgId, nodeId, [entry]);
  return saveLive(
    deps,
    files,
    { nodeId, orgId: node.orgId, base: node.contentVersion, mimeType: node.mimeType },
    live,
    through,
    () => live.markdown,
  );
}

/**
 * Saves the live document through record `through` as the file's next version (`body` is its
 * text now) and records the save in the stream, trying again on a newer version only when that
 * version did not already hold the change.
 */
export async function saveLive(
  deps: WriteDeps,
  files: MemberStorage,
  at: { nodeId: string; orgId: string; base: number; mimeType: string | null },
  live: LiveFile,
  through: number,
  body: () => string,
) {
  let base = at.base;
  for (let tries = 0; ; tries++) {
    const written = await writeText(
      deps,
      files,
      at.orgId,
      { nodeId: at.nodeId, ifContentVersion: base },
      body(),
      at.mimeType,
    );
    if (written.status === "ok") {
      passOn(deps, at.orgId, at.nodeId, [await live.folded(written.node.contentVersion, through)]);
      journalLater(deps, written.node);
      return written;
    }
    if (written.status !== "version_conflict" || tries >= SAVE_TRIES) return written;
    const [fold, now] = await Promise.all([live.lastFold(), files.file(at.nodeId)]);
    if (now.status !== "ok") return { status: "refused", reason: now.status } satisfies WriteResult;
    if (fold.cv !== now.file.contentVersion) return written;
    if (fold.s >= through) return { status: "ok", node: now.file } satisfies WriteResult;
    base = now.file.contentVersion;
  }
}
