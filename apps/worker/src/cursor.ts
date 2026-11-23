import { toBase64Url } from "@omni/crypto";
import { z } from "zod";
import { ApiFailure } from "./errors.ts";

/** A page cursor travels as base64url JSON: opaque to the client, checked on the way back in. */
export function encodeCursor(cursor: unknown) {
  if (!cursor) return null;
  return toBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

/**
 * Reads a cursor `encodeCursor` made, or null when it is not one. Takes base64url and standard
 * base64 alike, with or without padding, so cursors handed out before base64url still decode.
 */
export function readCursor<T extends z.ZodType>(value: string, schema: T) {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? { cursor: parsed.data as z.output<T> } : null;
  } catch {
    return null;
  }
}

/** Reads a cursor `encodeCursor` made; anything else is a 400 naming `cursor`. */
export function decodeCursor<T extends z.ZodType>(value: string | undefined, schema: T) {
  if (value === undefined) return null;
  const read = readCursor(value, schema);
  if (!read) throw new ApiFailure("bad_request", "invalid cursor", { param: "cursor" });
  return read.cursor;
}

/** A cursor query field for `zValidator`: one `encodeCursor` made, read against `schema`. */
export function cursorParam<T extends z.ZodType>(schema: T) {
  return z.string().transform((value, ctx) => {
    const read = readCursor(value, schema);
    if (read) return read.cursor;
    ctx.addIssue({ code: "custom", message: "invalid cursor" });
    return z.NEVER;
  });
}

/**
 * A page of rows ordered by a time then an id (conversations, notifications): the optional
 * `cursor` query field reads `{ at, id }`, and `timePageCursor` makes the next one.
 */
export const timePageQuery = cursorParam(z.object({ t: z.iso.datetime(), id: z.string().min(1) }))
  .transform((parsed) => ({ at: parsed.t, id: parsed.id }))
  .optional();

export const timePageCursor = (at: string, id: string) => encodeCursor({ t: at, id });
