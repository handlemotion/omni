import Anthropic from "@anthropic-ai/sdk";
import { transcribe, type ModelClient, type OcrSource } from "@omni/ai";
import {
  saveStorageText,
  storageFilesToRead,
  type Db,
  type StorageFileToRead,
  type StorageTextInput,
} from "@omni/db";
import { Effect, Result } from "effect";
import { loadConfig } from "../env.ts";
import { attempt, retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";
import { extract, finish, isPicture, maxBytesFor, readerFor } from "./extract.ts";

const FILES_PER_RUN = 25;
const RUN_BUDGET_MS = 40_000;
const OCR_PER_RUN = 8;
const OCR_TIMEOUT_MS = 60_000;
const OCR_PICTURE_EDGE = 1_568;
const OCR_PICTURE_MAX_BYTES = 20_000_000;
const OCR_PDF_MAX_BYTES = 20 * 1024 * 1024;
const OCR_PDF_MAX_PAGES = 100;

interface Ocr {
  client: ModelClient;
  left: number;
  log: Logger;
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function transcribed(ocr: Ocr, file: StorageFileToRead, source: OcrSource) {
  ocr.left--;
  const started = Date.now();
  const transcript = await transcribe(ocr.client, source);
  ocr.log.info("storage.ocr", {
    nodeId: file.id,
    orgId: file.orgId,
    kind: source.kind,
    tokensIn: transcript.usage.tokensIn,
    tokensOut: transcript.usage.tokensOut,
    durationMs: Date.now() - started,
  });
  const { text, truncated } = finish(transcript.text);
  return { text, truncated: truncated || transcript.truncated };
}

async function pictureText(env: Env, ocr: Ocr, file: StorageFileToRead) {
  const object = await env.STORAGE_BUCKET.get(file.r2Key);
  if (!object) return null;
  const drawn = await env.IMAGES.input(object.body)
    .transform({ width: OCR_PICTURE_EDGE, height: OCR_PICTURE_EDGE, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 85, anim: false });
  const bytes = new Uint8Array(await drawn.response().arrayBuffer());
  return transcribed(ocr, file, { kind: "image", mediaType: "image/jpeg", data: base64(bytes) });
}

async function readPicture(env: Env, ocr: Ocr | null, file: StorageFileToRead) {
  const base = { nodeId: file.id, orgId: file.orgId, contentVersion: file.contentVersion };
  if (!ocr) return { ...base, ocr: false, status: "unsupported" } satisfies StorageTextInput;
  if (file.size > OCR_PICTURE_MAX_BYTES)
    return { ...base, ocr: true, status: "too_large" } satisfies StorageTextInput;
  const read = await pictureText(env, ocr, file);
  if (!read) return { ...base, ocr: true, status: "failed" } satisfies StorageTextInput;
  return {
    ...base,
    ocr: true,
    status: read.text ? "ok" : "empty",
    ...read,
  } satisfies StorageTextInput;
}

const needsOcr = (reader: string, text: string, pages: number | null) =>
  reader === "pdf" && !text && pages !== null && pages > 0;

async function readText(env: Env, ocr: Ocr | null, file: StorageFileToRead, log: Logger) {
  const base = {
    nodeId: file.id,
    orgId: file.orgId,
    contentVersion: file.contentVersion,
    ocr: ocr !== null,
  };
  const reader = readerFor(file.name, file.mimeType);
  if (file.size === 0) return { ...base, status: "empty" } satisfies StorageTextInput;
  if (!reader && isPicture(file.name, file.mimeType)) {
    try {
      return await readPicture(env, ocr, file);
    } catch (error) {
      log.warn("storage.text_failed", { nodeId: file.id, reader: "picture", error });
      return { ...base, status: "failed" } satisfies StorageTextInput;
    }
  }
  if (!reader) return { ...base, status: "unsupported" } satisfies StorageTextInput;
  if (file.size > maxBytesFor(reader))
    return { ...base, status: "too_large" } satisfies StorageTextInput;
  const object = await env.STORAGE_BUCKET.get(file.r2Key);
  if (!object) return { ...base, status: "failed" } satisfies StorageTextInput;
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    const { text, truncated, pages } = await extract(reader, bytes);
    if (ocr && needsOcr(reader, text, pages)) {
      if (file.size > OCR_PDF_MAX_BYTES || pages! > OCR_PDF_MAX_PAGES)
        return { ...base, status: "too_large" } satisfies StorageTextInput;
      const read = await transcribed(ocr, file, { kind: "pdf", data: base64(bytes) });
      return { ...base, status: read.text ? "ok" : "empty", ...read } satisfies StorageTextInput;
    }
    return { ...base, status: text ? "ok" : "empty", text, truncated } satisfies StorageTextInput;
  } catch (error) {
    log.warn("storage.text_failed", { nodeId: file.id, reader, error });
    return { ...base, status: "failed" } satisfies StorageTextInput;
  }
}

function indexOne(env: Env, db: Db, ocr: Ocr | null, file: StorageFileToRead, log: Logger) {
  return Effect.gen(function* () {
    const read = yield* attempt("read_text", () => readText(env, ocr, file, log));
    yield* retried("save_text", () => saveStorageText(db, read));
  });
}

function ocrFor(env: Env, log: Logger) {
  const config = loadConfig(env);
  if (!config.ANTHROPIC_API_KEY || config.DRIVE_OCR === "off") return null;
  const client = new Anthropic({
    apiKey: config.ANTHROPIC_API_KEY,
    baseURL: config.ANTHROPIC_BASE_URL ?? null,
    timeout: OCR_TIMEOUT_MS,
    maxRetries: 0,
  });
  return { client, left: OCR_PER_RUN, log } satisfies Ocr;
}

/**
 * The every-minute indexer: reads the text of files whose text is missing or behind their
 * content, newest first, until the run's file count or time budget is spent. New uploads, new
 * versions and every file from before the indexer existed all go through it; running it twice
 * reads a file twice and writes the same row. With a model key set, pictures and scanned PDFs
 * are transcribed by the model, a few per run.
 */
export function indexStorageTexts(env: Env) {
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  const started = Date.now();
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const ocr = ocrFor(env, log);
      const files = yield* retried("files_to_read", () =>
        storageFilesToRead(db, FILES_PER_RUN, { ocr: ocr !== null }),
      );
      let read = 0;
      for (const file of files) {
        if (Date.now() - started > RUN_BUDGET_MS) break;
        if (ocr && ocr.left <= 0 && mayNeedOcr(file)) continue;
        const saved = yield* Effect.result(indexOne(env, db, ocr, file, log));
        if (Result.isFailure(saved))
          log.error("storage.text_not_saved", { nodeId: file.id, error: saved.failure.cause });
        read++;
      }
      if (read) log.info("storage.texts_read", { count: read, waiting: files.length - read });
    }),
  );
}

const mayNeedOcr = (file: StorageFileToRead) =>
  isPicture(file.name, file.mimeType) || readerFor(file.name, file.mimeType) === "pdf";
