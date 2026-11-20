import {
  saveStorageText,
  storageFilesToRead,
  type Db,
  type StorageFileToRead,
  type StorageTextInput,
} from "@omni/db";
import { Effect, Result } from "effect";
import { retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";
import { extract, maxBytesFor, readerFor } from "./extract.ts";

const FILES_PER_RUN = 25;
const RUN_BUDGET_MS = 40_000;

async function readText(env: Env, file: StorageFileToRead, log: Logger) {
  const base = { nodeId: file.id, orgId: file.orgId, contentVersion: file.contentVersion };
  const reader = readerFor(file.name, file.mimeType);
  if (!reader) return { ...base, status: "unsupported" } satisfies StorageTextInput;
  if (file.size > maxBytesFor(reader))
    return { ...base, status: "too_large" } satisfies StorageTextInput;
  if (file.size === 0) return { ...base, status: "empty" } satisfies StorageTextInput;
  const object = await env.STORAGE_BUCKET.get(file.r2Key);
  if (!object) return { ...base, status: "failed" } satisfies StorageTextInput;
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    const { text, truncated } = await extract(reader, bytes);
    return {
      ...base,
      status: text ? "ok" : "empty",
      text,
      truncated,
    } satisfies StorageTextInput;
  } catch (error) {
    log.warn("storage.text_failed", { nodeId: file.id, reader, error });
    return { ...base, status: "failed" } satisfies StorageTextInput;
  }
}

function indexOne(env: Env, db: Db, file: StorageFileToRead, log: Logger) {
  return retried("save_text", async () => saveStorageText(db, await readText(env, file, log)));
}

/**
 * The every-minute indexer: reads the text of files whose text is missing or behind their
 * content, newest first, until the run's file count or time budget is spent. New uploads, new
 * versions and every file from before the indexer existed all go through it; running it twice
 * reads a file twice and writes the same row.
 */
export function indexStorageTexts(env: Env) {
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  const started = Date.now();
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const files = yield* retried("files_to_read", () => storageFilesToRead(db, FILES_PER_RUN));
      let read = 0;
      for (const file of files) {
        if (Date.now() - started > RUN_BUDGET_MS) break;
        const saved = yield* Effect.result(indexOne(env, db, file, log));
        if (Result.isFailure(saved))
          log.error("storage.text_not_saved", { nodeId: file.id, error: saved.failure.cause });
        read++;
      }
      if (read) log.info("storage.texts_read", { count: read, waiting: files.length - read });
    }),
  );
}
