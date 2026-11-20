import { crc32 } from "node:zlib";
import { STORAGE_ZIP_MAX_ENTRIES, storageZipQuerySchema } from "@omni/contracts";
import type { ArchiveResult } from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { attachmentDisposition } from "./core.ts";
import { refused } from "./http.ts";

const MAX_U32 = 0xffff_ffff;
const ZIP64_VERSION = 45;
const UNIX_ZIP64_MADE_BY = (3 << 8) | ZIP64_VERSION;
const DESCRIPTOR_UTF8_FLAGS = 0x0808;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_RECORD_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_END_AND_LOCATOR_BYTES = 56 + 20;

interface Entry {
  name: Uint8Array;
  folder: boolean;
  size: number;
  r2Key: string | null;
  date: number;
  time: number;
}

const big = (value: number) => value >= MAX_U32;
const descriptorLength = (entry: Entry) => (big(entry.size) ? 24 : 16);
const extraLength = (entry: Entry, offset: number) => (big(entry.size) ? 28 : big(offset) ? 12 : 0);

function dosTime(at: Date) {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
  };
}

const view = (length: number) => {
  const bytes = new Uint8Array(length);
  return { bytes, data: new DataView(bytes.buffer) };
};

function localHeader(entry: Entry) {
  const { bytes, data } = view(LOCAL_HEADER_BYTES + entry.name.length);
  data.setUint32(0, 0x04034b50, true);
  data.setUint16(4, ZIP64_VERSION, true);
  data.setUint16(6, DESCRIPTOR_UTF8_FLAGS, true);
  data.setUint16(10, entry.time, true);
  data.setUint16(12, entry.date, true);
  data.setUint16(26, entry.name.length, true);
  bytes.set(entry.name, LOCAL_HEADER_BYTES);
  return bytes;
}

function descriptor(entry: Entry, crc: number) {
  const { bytes, data } = view(descriptorLength(entry));
  data.setUint32(0, 0x08074b50, true);
  data.setUint32(4, crc, true);
  if (big(entry.size)) {
    data.setBigUint64(8, BigInt(entry.size), true);
    data.setBigUint64(16, BigInt(entry.size), true);
  } else {
    data.setUint32(8, entry.size, true);
    data.setUint32(12, entry.size, true);
  }
  return bytes;
}

function centralRecord(entry: Entry, crc: number, offset: number) {
  const extra = extraLength(entry, offset);
  const { bytes, data } = view(CENTRAL_RECORD_BYTES + entry.name.length + extra);
  data.setUint32(0, 0x02014b50, true);
  data.setUint16(4, UNIX_ZIP64_MADE_BY, true);
  data.setUint16(6, ZIP64_VERSION, true);
  data.setUint16(8, DESCRIPTOR_UTF8_FLAGS, true);
  data.setUint16(12, entry.time, true);
  data.setUint16(14, entry.date, true);
  data.setUint32(16, crc, true);
  data.setUint32(20, Math.min(entry.size, MAX_U32), true);
  data.setUint32(24, Math.min(entry.size, MAX_U32), true);
  data.setUint16(28, entry.name.length, true);
  data.setUint16(30, extra, true);
  data.setUint32(38, (entry.folder ? 0o40755 : 0o100644) * 0x10000, true);
  data.setUint32(42, Math.min(offset, MAX_U32), true);
  bytes.set(entry.name, CENTRAL_RECORD_BYTES);
  if (extra) {
    let at = CENTRAL_RECORD_BYTES + entry.name.length;
    data.setUint16(at, 0x0001, true);
    data.setUint16(at + 2, extra - 4, true);
    at += 4;
    if (big(entry.size)) {
      data.setBigUint64(at, BigInt(entry.size), true);
      data.setBigUint64(at + 8, BigInt(entry.size), true);
      at += 16;
    }
    data.setBigUint64(at, BigInt(offset), true);
  }
  return bytes;
}

function endRecords(count: number, centralSize: number, centralOffset: number) {
  const zip64 = big(centralOffset) || big(centralSize) || count >= 0xffff;
  const { bytes, data } = view((zip64 ? ZIP64_END_AND_LOCATOR_BYTES : 0) + END_RECORD_BYTES);
  let at = 0;
  if (zip64) {
    data.setUint32(0, 0x06064b50, true);
    data.setBigUint64(4, 44n, true);
    data.setUint16(12, UNIX_ZIP64_MADE_BY, true);
    data.setUint16(14, ZIP64_VERSION, true);
    data.setBigUint64(24, BigInt(count), true);
    data.setBigUint64(32, BigInt(count), true);
    data.setBigUint64(40, BigInt(centralSize), true);
    data.setBigUint64(48, BigInt(centralOffset), true);
    data.setUint32(56, 0x07064b50, true);
    data.setBigUint64(64, BigInt(centralOffset + centralSize), true);
    data.setUint32(72, 1, true);
    at = ZIP64_END_AND_LOCATOR_BYTES;
  }
  data.setUint32(at, 0x06054b50, true);
  data.setUint16(at + 8, Math.min(count, 0xffff), true);
  data.setUint16(at + 10, Math.min(count, 0xffff), true);
  data.setUint32(at + 12, Math.min(centralSize, MAX_U32), true);
  data.setUint32(at + 16, Math.min(centralOffset, MAX_U32), true);
  return bytes;
}

function zipLength(entries: Entry[]) {
  let offset = 0;
  let central = 0;
  for (const entry of entries) {
    central += CENTRAL_RECORD_BYTES + entry.name.length + extraLength(entry, offset);
    offset += LOCAL_HEADER_BYTES + entry.name.length + entry.size + descriptorLength(entry);
  }
  const zip64 = big(offset) || big(central) || entries.length >= 0xffff;
  return offset + central + (zip64 ? ZIP64_END_AND_LOCATOR_BYTES : 0) + END_RECORD_BYTES;
}

async function writeZip(
  bucket: R2Bucket,
  entries: Entry[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
) {
  const write = async (chunk: Uint8Array) => {
    if (writer.desiredSize !== null && writer.desiredSize <= 0) await writer.ready;
    writer.write(chunk).catch(() => {});
  };
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    await write(localHeader(entry));
    let crc = 0;
    let read = 0;
    if (entry.r2Key) {
      const object = await bucket.get(entry.r2Key);
      if (!object) throw new Error("storage.zip_object_missing");
      for await (const chunk of object.body) {
        crc = crc32(chunk, crc);
        read += chunk.byteLength;
        await write(chunk);
      }
    }
    if (read !== entry.size) throw new Error("storage.zip_size_mismatch");
    await write(descriptor(entry, crc));
    central.push(centralRecord(entry, crc, offset));
    offset += LOCAL_HEADER_BYTES + entry.name.length + entry.size + descriptorLength(entry);
  }
  let centralSize = 0;
  for (const record of central) {
    centralSize += record.length;
    await write(record);
  }
  await write(endRecords(entries.length, centralSize, offset));
  await writer.close();
}

const encoder = new TextEncoder();

async function requestedIds(c: Context<AppEnv>) {
  if (c.req.method !== "POST") return c.req.queries("ids") ?? [];
  const type = c.req.header("content-type") ?? "";
  if (type.startsWith("application/json")) {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
    return body?.ids;
  }
  const form = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
  return form.ids;
}

/**
 * `GET|POST /zip`: the selection as one zip download, read through `archive` (the door the
 * caller came in by). Nothing is refused after the first byte but a missing object, which ends
 * the stream short and is logged: the client sees a failed download, never a wrong file.
 */
export async function zip(
  c: Context<AppEnv>,
  archive: (nodeIds: string[], max: number) => Promise<ArchiveResult>,
  fallbackId?: string,
) {
  const parsed = storageZipQuerySchema.safeParse({ ids: (await requestedIds(c)) ?? [] });
  if (!parsed.success) return apiError(c, "bad_request", "send up to 5000 ids as `ids`");
  const ids = parsed.data.ids.length ? parsed.data.ids : fallbackId ? [fallbackId] : [];
  if (!ids.length) return apiError(c, "bad_request", "send the ids to zip as `ids`");

  const found = await archive(ids, STORAGE_ZIP_MAX_ENTRIES);
  if (found.status === "too_many") {
    return apiError(c, "zip_too_large", `a zip holds up to ${STORAGE_ZIP_MAX_ENTRIES} items`);
  }
  if (found.status !== "ok") return refused(c, found.status);

  const entries = found.entries.map((entry) => {
    const folder = entry.kind === "folder";
    return {
      name: encoder.encode(folder ? `${entry.path}/` : entry.path),
      folder,
      size: folder ? 0 : entry.size,
      r2Key: folder ? null : entry.r2Key,
      ...dosTime(entry.updatedAt),
    } satisfies Entry;
  });
  const roots = new Set(found.entries.map((entry) => entry.path.split("/")[0]));
  const name = roots.size === 1 && ids.length === 1 ? `${[...roots][0]}.zip` : "download.zip";

  const length = zipLength(entries);
  const { readable, writable } = new FixedLengthStream(length);
  const writer = writable.getWriter();
  const log = c.var.log;
  void writeZip(c.env.STORAGE_BUCKET, entries, writer).catch((error: unknown) => {
    log.error("storage.zip_failed", { error });
    return writer.abort(error).catch(() => {});
  });
  return new Response(readable, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": attachmentDisposition(name),
      "content-length": String(length),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
