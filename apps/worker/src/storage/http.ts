// What Storage's route files share: the doors a request goes through, the API's error answers,
// cursors and the one way a file is served.
import type { ErrorCode, StorageNodeView, StorageSpace } from "@omni/contracts";
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
import { apiError } from "../errors.ts";
import { fileResponse, wireNode } from "./core.ts";

const FAILURES = {
  not_found: ["not_found", "not found"],
  forbidden: ["forbidden", "you cannot change this"],
  invalid_name: ["invalid_name", "that name cannot be used"],
  name_taken: ["name_taken", "something here already has that name"],
  too_deep: ["too_deep", "folders cannot nest that deep"],
  cycle: ["cycle", "a folder cannot move into itself"],
  parent_trashed: ["parent_trashed", "the folder it was in is in Trash: restore that one"],
  not_trashed: ["not_trashed", "only what is in Trash is deleted for good"],
  locked: ["locked", "a locked file cannot be renamed, moved, trashed or deleted"],
  full: ["storage_full", "this workspace's storage is full"],
  incomplete: ["upload_incomplete", "the upload is missing parts"],
  too_large: ["invalid_part", "the part does not fit the upload"],
  invalid_email: ["invalid_email", "that is not an email address"],
  version_conflict: ["version_conflict", "it changed since you read it"],
} as const satisfies Record<string, readonly [ErrorCode, string]>;

/** The API's error answer for a result `@omni/db` refused, with a code the client can act on. */
export function refused(c: Context<AppEnv>, status: keyof typeof FAILURES) {
  const [code, message] = FAILURES[status];
  return apiError(c, code, message);
}

export const memberStorage = (c: Context<AppEnv>) => forMember(c.var.db, c.var.member.id).storage;

/**
 * A request made at `/shared/:shareId` (`shared.ts`): what the link carries, and the door
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

export const wireView = ({ node, role, path }: NodeViewRow): StorageNodeView => ({
  node: wireNode(node),
  role,
  path,
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
