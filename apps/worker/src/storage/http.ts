import type { ErrorCode, StorageNodeView, StorageSpace } from "@omni/contracts";
import {
  forMember,
  type FileResult,
  type MemberStorage,
  type SharedStorage,
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
  locked: ["locked", "a locked file cannot be changed, moved, trashed or deleted"],
  full: ["storage_full", "this workspace's storage is full"],
  incomplete: ["upload_incomplete", "the upload is missing parts"],
  too_large: ["invalid_part", "the part does not fit the upload"],
  invalid_email: ["invalid_email", "that is not an email address"],
  version_conflict: ["version_conflict", "it changed since you read it"],
  policy: ["sharing_policy", "your workspace's sharing policy does not allow that"],
  too_many_uploads: ["too_many_uploads", "finish or cancel some uploads first"],
  not_empty: ["not_empty", "the teamspace still holds files: move them out or to Trash first"],
  last_owner: ["last_owner", "a teamspace keeps one owner"],
  not_in_workspace: ["not_in_workspace", "only members of the workspace can be in its teamspaces"],
} as const satisfies Record<string, readonly [ErrorCode, string]>;

/** The API's error answer for a result `@omni/db` refused, with a code the client can act on. */
export function refused(c: Context<AppEnv>, status: keyof typeof FAILURES) {
  const [code, message] = FAILURES[status];
  return apiError(c, code, message);
}

/** A checked save based on content the file no longer has: its `contentVersion` now. */
export const staleSave = (c: Context<AppEnv>, contentVersion: number) =>
  apiError(c, "version_conflict", "the file changed since this was based on it", {
    details: { contentVersion },
  });

export const memberStorage: (c: Context<AppEnv>) => MemberStorage = (c) =>
  forMember(c.var.db, c.var.member.id).storage;

export type { SharedAccess } from "@omni/db";

/**
 * The door a change goes through and the workspace it lands in: at `/shared/:shareId` the door
 * that opened the link and the shared node's workspace, anywhere else the member's own. The
 * routes that change files are written once against this and mounted in both places.
 */
export const writeDoor: (c: Context<AppEnv>) => {
  files: MemberStorage | SharedStorage;
  orgId: string;
} = (c) => {
  const shared = c.var.shared;
  if (!shared) return { files: memberStorage(c), orgId: c.var.member.orgId };
  if (!shared.writer) throw new HTTPException(403, { message: "you cannot change this" });
  return { files: shared.writer, orgId: shared.root.node.orgId };
};

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

export const wireView = ({ node, role, path }: NodeViewRow) =>
  ({
    node: wireNode(node),
    role,
    path,
  }) satisfies StorageNodeView;

/**
 * The file's bytes, always as a download (see `fileResponse`): the one way a file leaves, for a
 * member, a person it was shared with and a link.
 */
export async function download(c: Context<AppEnv>, found: FileResult) {
  if (found.status !== "ok") return refused(c, found.status);
  const response = await fileResponse(
    c.env.STORAGE_BUCKET,
    {
      name: found.file.name,
      size: found.file.size,
      r2Key: found.r2Key,
      mimeType: found.file.mimeType,
    },
    c.req.raw.headers,
  );
  if (response) return response;
  c.var.log.error("storage.object_missing", { orgId: found.file.orgId, nodeId: found.file.id });
  return refused(c, "not_found");
}

/** A request's `parentId` or `space` (the schemas require exactly one) as a place. */
export const placeOf: (input: {
  parentId?: string;
  space?: StorageSpace;
  teamspaceId?: string;
}) => StoragePlace = (input) => {
  if (input.parentId !== undefined) return { parentId: input.parentId };
  if (input.teamspaceId !== undefined) return { teamspaceId: input.teamspaceId };
  return { space: input.space ?? "personal" };
};
