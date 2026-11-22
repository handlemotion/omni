import {
  CANVAS_MAX_BYTES,
  CANVAS_TYPE,
  isOmniCanvas,
  liveScene,
  rewriteCanvas,
  sceneFromJson,
  sceneToJson,
  type OpsResult,
  type Scene,
} from "@omni/canvas";
import type { MemberStorage, StoragePlace } from "@omni/db";
import { s2Basin } from "../s2.ts";
import { LiveFile } from "./doc-live.ts";
import { refusalFor, writeText, type WriteDeps, type WriteResult } from "./doc-write.ts";
import { passOn, saveLive } from "./docs.ts";

const sizeOf = (text: string) => new TextEncoder().encode(text).byteLength;

/** A new canvas at `place`, holding `scene`. */
export function createCanvas(
  deps: WriteDeps,
  files: MemberStorage,
  orgId: string,
  input: { place: StoragePlace; name: string; scene: Scene },
) {
  const body = sceneToJson(input.scene);
  if (sizeOf(body) > CANVAS_MAX_BYTES) return { status: "too_large_after" } as const;
  return writeText(
    deps,
    files,
    orgId,
    { place: input.place, name: input.name.trim() },
    body,
    CANVAS_TYPE,
  );
}

async function savedScene(bucket: R2Bucket, r2Key: string) {
  const object = await bucket.get(r2Key);
  return sceneFromJson(object ? await object.text() : "");
}

/**
 * The canvas as it is now: from its live document when people are editing it (their unsaved
 * changes included), else from the file. `live` is null when nobody is.
 */
export async function currentScene(
  deps: Pick<WriteDeps, "config" | "env">,
  node: { id: string; contentVersion: number },
  r2Key: string,
) {
  const basin = s2Basin(deps.config);
  const live = basin ? await LiveFile.open(basin, node.id, node.contentVersion) : null;
  if (live) return { live, read: { ok: true, scene: liveScene(live.doc) } as const };
  return { live, read: await savedScene(deps.env.STORAGE_BUCKET, r2Key) };
}

/**
 * Changes a canvas with `change`, made on the canvas as it is now. While people edit it live the
 * change goes into their live document, merged with what they do, and is saved from there;
 * otherwise it is the file's next version. Answers the write, the change, and the scene after it
 * (with whatever others changed meanwhile).
 */
export async function editCanvas(
  deps: WriteDeps,
  files: MemberStorage,
  nodeId: string,
  change: (scene: Scene) => OpsResult,
) {
  const found = await files.file(nodeId);
  if (found.status !== "ok") return found;
  const node = found.file;
  if (!isOmniCanvas(node.mimeType)) return { status: "not_a_canvas" } as const;
  if (node.lockedAt) return { status: "locked" } as const;
  if (node.size > CANVAS_MAX_BYTES * 2) return { status: "too_large" } as const;
  const writable = await files.mayWrite(nodeId);
  if (writable !== "ok") return { status: writable } as const;
  const { live, read } = await currentScene(deps, node, found.r2Key);
  if (!read.ok) return { status: "unreadable", error: read.error } as const;
  const changed = change(read.scene);
  if (!changed.ok) return { status: "invalid", error: changed.error, scene: read.scene } as const;
  const body = sceneToJson(changed.scene);
  const size = sizeOf(body);
  if (size > CANVAS_MAX_BYTES && size > sizeOf(sceneToJson(read.scene))) {
    return { status: "too_large_after" } as const;
  }
  const target = { nodeId, ifContentVersion: node.contentVersion };
  if (!live) {
    const written = await writeText(deps, files, node.orgId, target, body, node.mimeType);
    return { ...written, changed, scene: changed.scene };
  }
  const refused = await refusalFor(deps, files, node.orgId, target, body, node.mimeType);
  if (refused && refused.status !== "ok") return refused;
  await files.endSession(nodeId);
  const { entries, through, mine } = await live.append(rewriteCanvas(live.doc, changed.scene));
  passOn(deps, node.orgId, nodeId, entries);
  const at = { nodeId, orgId: node.orgId, base: node.contentVersion, mimeType: node.mimeType };
  const saved: WriteResult = await saveLive(deps, files, at, live, { through, mine }, () =>
    sceneToJson(liveScene(live.doc)),
  );
  return { ...saved, changed, scene: liveScene(live.doc) };
}
