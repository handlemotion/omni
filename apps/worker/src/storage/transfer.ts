import { STORAGE_PART_BYTES } from "@omni/contracts";
import { transferOfKey, type TransferGrant } from "@omni/crypto";
import { forMember, forUser } from "@omni/db";
import { Hono, type Context } from "hono";
import { findMember, type AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { download, refused, writeDoor } from "./http.ts";
import { completeUpload, storePart } from "./uploads.ts";

/** The most a single `PUT` carries: a Worker's request body cap is 100 MB. Larger goes by part. */
export const STORAGE_TRANSFER_WHOLE_BYTES = 6 * STORAGE_PART_BYTES;

async function grantOf(c: Context<AppEnv>, kind: TransferGrant["kind"]) {
  const grant = await transferOfKey(c.var.config.auth.secret, c.req.param("key") ?? "");
  if (grant?.kind !== kind) {
    return apiError(c, "not_found", "this link has expired or is not one Wok made: ask again");
  }
  if (!grant.orgId) return grant;
  const member = await findMember(c.var.db, grant.userId, grant.orgId, grant.scope);
  if (member?.orgId !== grant.orgId) return refused(c, "not_found");
  c.set("member", member);
  return grant;
}

async function* partsOf(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let held: Uint8Array[] = [];
  let bytes = 0;
  const take = (size: number) => {
    const part = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const head = held[0]!;
      const used = Math.min(head.byteLength, size - at);
      part.set(head.subarray(0, used), at);
      at += used;
      if (used === head.byteLength) held.shift();
      else held[0] = head.subarray(used);
    }
    bytes -= size;
    return part;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held.push(value);
    bytes += value.byteLength;
    while (bytes >= STORAGE_PART_BYTES) yield take(STORAGE_PART_BYTES);
  }
  if (bytes > 0) yield take(bytes);
  held = [];
}

async function putWhole(c: Context<AppEnv>, grant: TransferGrant, length: number) {
  const upload = await writeDoor(c).files.uploadRow(grant.subject);
  if (!upload) return refused(c, "not_found");
  if (length !== upload.size) {
    return apiError(
      c,
      "invalid_part",
      `send exactly ${upload.size} bytes, the size the upload was opened with`,
    );
  }
  if (length > STORAGE_TRANSFER_WHOLE_BYTES) {
    return apiError(
      c,
      "payload_too_large",
      "send this file in parts: PUT ?part=1, 2, …, then POST",
    );
  }
  const body = c.req.raw.body;
  let n = 0;
  if (body) {
    for await (const part of partsOf(body)) {
      const stored = await storePart(c, grant.subject, ++n, part, part.byteLength);
      if (stored.status !== 200) return stored;
    }
  }
  return completeUpload(c, grant.subject, grant.ifContentVersion);
}

/**
 * Bytes in and out of Drive for an agent's machine, by a link `drive_upload` or `drive_download`
 * signed (`signTransferKey`): `curl -T file <url>` or `curl -o file <url>`. The key names the
 * person and the file or upload; who may open it is checked again here, through the same doors.
 */
export const storageTransfer = new Hono<AppEnv>()
  .get("/:key", async (c) => {
    const grant = await grantOf(c, "get");
    if (grant instanceof Response) return grant;
    const files = grant.orgId
      ? forMember(c.var.db, c.var.member.id).storage
      : forUser(c.var.db, grant.userId, grant.scope).storage;
    return download(c, await files.file(grant.subject));
  })

  .put("/:key", async (c) => {
    const grant = await grantOf(c, "put");
    if (grant instanceof Response) return grant;
    const length = Number(c.req.header("content-length"));
    if (!Number.isSafeInteger(length) || length < 0) {
      return apiError(c, "length_required", "content-length required");
    }
    const part = c.req.query("part");
    if (part === undefined) return putWhole(c, grant, length);
    const stored = await storePart(c, grant.subject, Number(part), c.req.raw.body, length);
    const body = c.req.raw.body;
    if (body && !body.locked) await body.pipeTo(new WritableStream()).catch(() => {});
    return stored;
  })

  .post("/:key", async (c) => {
    const grant = await grantOf(c, "put");
    if (grant instanceof Response) return grant;
    return completeUpload(c, grant.subject, grant.ifContentVersion);
  });
