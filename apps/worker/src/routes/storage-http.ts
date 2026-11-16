// What Storage's route files share: the doors a request goes through, the API's error answers,
// cursors and the one way a file is served.
import type { StorageErrorCode, StorageNodeView, StorageSpace } from "@omni/contracts";
import {
  forMember,
  type FileResult,
  type ListResult,
  type MemberStorage,
  type SharedStorage,
  type StorageListCursor,
  type StorageNodeView as NodeViewRow,
  type StoragePlace,
} from "@omni/db";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { fileResponse, wireNode } from "../storage.ts";

type Status = 400 | 402 | 403 | 404 | 409 | 413;

const FAILURES = {
  not_found: [404, "NOT_FOUND", "not found"],
  forbidden: [403, "FORBIDDEN", "you cannot change this"],
  invalid_name: [400, "INVALID_NAME", "that name cannot be used"],
  name_taken: [409, "NAME_TAKEN", "something here already has that name"],
  too_deep: [409, "TOO_DEEP", "folders cannot nest that deep"],
  cycle: [409, "CYCLE", "a folder cannot move into itself"],
  parent_trashed: [409, "PARENT_TRASHED", "the folder it was in is in Trash: restore that one"],
  not_trashed: [409, "NOT_TRASHED", "only what is in Trash is deleted for good"],
  full: [402, "STORAGE_FULL", "this workspace's storage is full"],
  incomplete: [409, "UPLOAD_INCOMPLETE", "the upload is missing parts"],
  too_large: [400, "INVALID_PART", "the part does not fit the upload"],
  invalid_email: [400, "INVALID_EMAIL", "that is not an email address"],
} as const satisfies Record<string, readonly [Status, StorageErrorCode, string]>;

/** The API's error shape for a result `@omni/db` refused, with a code the client can act on. */
export function refused(c: Context<AppEnv>, status: keyof typeof FAILURES) {
  const [http, code, error] = FAILURES[status];
  return c.json({ error, code, requestId: c.var.requestId }, http);
}

export function fail(c: Context<AppEnv>, http: Status, code: StorageErrorCode, error: string) {
  return c.json({ error, code, requestId: c.var.requestId }, http);
}

export const memberStorage = (c: Context<AppEnv>) => forMember(c.var.db, c.var.member.id).storage;

/**
 * A request made at `/shared/:shareId` (`storage-shared.ts`): what the link carries, and the door
 * that opened it. The member door, when the signed-in person reaches the item as a member of
 * its workspace; else a grant, when they have one; else the link itself.
 */
export interface SharedAccess {
  /** The node carrying the link. */
  root: NodeViewRow;
  node(nodeId: string): Promise<NodeViewRow | null>;
  list(
    parentId: string,
    page: { cursor?: StorageListCursor | null; limit?: number },
  ): Promise<ListResult>;
  file(nodeId: string): Promise<FileResult>;
  /** The member or grant door that opened it, for changes. A link alone never writes. */
  writer: MemberStorage | SharedStorage | null;
}

/**
 * The door a change goes through and the workspace it lands in: at `/shared/:shareId` the door
 * that opened the link and the shared node's workspace, anywhere else the member's own. The
 * routes that change files are written once against this and mounted in both places.
 */
export function writeDoor(c: Context<AppEnv>): {
  files: MemberStorage | SharedStorage;
  orgId: string;
} {
  const shared = c.var.shared;
  if (!shared) return { files: memberStorage(c), orgId: c.var.member.orgId };
  if (!shared.writer) throw new HTTPException(403, { message: "you cannot change this" });
  return { files: shared.writer, orgId: shared.root.node.orgId };
}

/** A cursor travels as base64url JSON: opaque to the client, checked on the way back in. */
export function encodeCursor(cursor: unknown) {
  if (!cursor) return null;
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeCursor<T extends z.ZodType>(value: string | undefined, schema: T) {
  if (value === undefined) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return schema.parse(JSON.parse(json)) as z.output<T>;
  } catch {
    throw new HTTPException(400, { message: "invalid cursor" });
  }
}

export const listCursor = z.object({
  kind: z.enum(["folder", "file"]),
  name: z.string(),
  id: z.string().min(1),
});

export const wireView = (view: NodeViewRow): StorageNodeView => ({
  ...view,
  node: wireNode(view.node),
});

/**
 * The file's bytes, always as a download (see `fileResponse`): the one way a file leaves, for a
 * member, a person it was shared with and a link.
 */
export async function download(c: Context<AppEnv>, found: FileResult) {
  if (found.status !== "ok") return refused(c, found.status);
  const response = await fileResponse(
    c.env.STORAGE_BUCKET,
    { name: found.file.name, size: found.file.size, r2Key: found.r2Key },
    { range: c.req.header("range"), ifRange: c.req.header("if-range") },
  );
  if (response) return response;
  // The row is the truth and its bytes are gone: someone must know.
  c.var.log.error("storage.object_missing", { orgId: found.file.orgId, nodeId: found.file.id });
  return refused(c, "not_found");
}

/** A request's `parentId` or `space` (the schemas require exactly one) as a place. */
export function placeOf(input: { parentId?: string; space?: StorageSpace }): StoragePlace {
  if (input.parentId !== undefined) return { parentId: input.parentId };
  return { space: input.space ?? "personal" };
}
