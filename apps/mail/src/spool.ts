// Large mail goes through temp files instead of memory: a 25 MB attachment fetched, parsed and
// uploaded whole costs over ten times its size in RSS, more than the service's VM has.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Bytes on disk, with the SHA-256 the object key is named after. */
export interface SpooledFile {
  path: string;
  size: number;
  sha256: string;
}

/** Writes `content` to a new temp file, hashing it on the way. Remove it with `discard`. */
export async function spool(content: Readable): Promise<SpooledFile> {
  const path = join(tmpdir(), `omni-${randomUUID()}`);
  const hash = createHash("sha256");
  let size = 0;
  const measure = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(content, measure, createWriteStream(path));
  } catch (error) {
    await discard(path);
    throw error;
  }
  return { path, size, sha256: hash.digest("hex") };
}

export async function discard(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function isSpooled(raw: Uint8Array | SpooledFile): raw is SpooledFile {
  return !(raw instanceof Uint8Array);
}
