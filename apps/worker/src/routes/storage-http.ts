// What Storage's route files share: the member's door and the API's error answers.
import type { StorageErrorCode, StorageSpace } from "@omni/contracts";
import { forMember, type StoragePlace } from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";

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

/** A request's `parentId` or `space` (the schemas require exactly one) as a place. */
export function placeOf(input: { parentId?: string; space?: StorageSpace }): StoragePlace {
  if (input.parentId !== undefined) return { parentId: input.parentId };
  return { space: input.space ?? "personal" };
}
