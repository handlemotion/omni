import { STORAGE_SIGNING_CONSENT } from "@omni/contracts";
import {
  recordStorageSeal,
  sealedObject,
  storageSealInput,
  unsealedSignatureRequests,
  type Db,
  type StorageNode,
  type StorageSealInput,
} from "@omni/db";
import { Effect } from "effect";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Context } from "hono";
import { systemMailSender, type AppEnv } from "../context.ts";
import { openDb } from "../db.ts";
import type { Config } from "../env.ts";
import { loadConfig } from "../env.ts";
import { retried, runJob, scopedDb } from "../job-effects.ts";
import { createLogger, type Logger } from "../log.ts";

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 50;
const SIZE = 9;
const LEADING = 13;

const printable = (text: string) => text.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

const utc = (date: Date | null) =>
  date ? `${date.toISOString().replace("T", " ").slice(0, 19)} UTC` : "-";

/** The audit page's lines, top to bottom. A heading line starts with `# `. */
export function auditLines(input: StorageSealInput) {
  const { request } = input;
  const lines = [
    "# Signature certificate",
    `Document: ${input.fileName}`,
    `Request: ${request.id}`,
    `Workspace: ${input.workspaceName}`,
    `Sent by: ${input.sentBy ?? "a former member"} on ${utc(request.createdAt)}`,
    `Completed: ${utc(request.completedAt)}`,
    `SHA-256 of the document sent: ${request.documentSha256}`,
    "",
    `# Consent (version ${STORAGE_SIGNING_CONSENT.version})`,
    STORAGE_SIGNING_CONSENT.text,
    "",
    "# Signers",
  ];
  for (const signer of request.signers) {
    lines.push(
      `${signer.name} <${signer.email}>`,
      `  Signed as "${signer.typedName ?? ""}" on ${utc(signer.signedAt)}`,
    );
  }
  lines.push("", "# Audit trail");
  const until = request.completedAt?.getTime() ?? Infinity;
  for (const event of request.events.filter((e) => e.createdAt.getTime() <= until)) {
    lines.push(
      `${utc(event.createdAt)}  ${event.kind}  ${event.email}  IP ${event.ip ?? "-"}`,
      `  ${event.userAgent ?? "-"}`,
    );
  }
  lines.push(
    "",
    "A simple electronic signature: each signer controlled their mailbox at signing time, as a",
    "one-time code mailed to it shows, and typed their name after accepting the consent above.",
  );
  return lines satisfies string[];
}

function wrap(text: string, font: PDFFont, width: number) {
  const out: string[] = [];
  let line = "";
  for (const char of text) {
    if (line && font.widthOfTextAtSize(line + char, SIZE) > width) {
      const space = line.lastIndexOf(" ");
      if (space > 0) {
        out.push(line.slice(0, space));
        line = line.slice(space + 1);
      } else {
        out.push(line);
        line = "";
      }
    }
    line += char;
  }
  out.push(line);
  return out satisfies string[];
}

async function addAuditPages(pdf: PDFDocument, input: StorageSealInput) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE.width - 2 * MARGIN;
  let page: PDFPage | null = null;
  let y = 0;
  for (const raw of auditLines(input)) {
    const heading = raw.startsWith("# ");
    const text = printable(heading ? raw.slice(2) : raw);
    for (const line of wrap(text, heading ? bold : font, width)) {
      if (!page || y < MARGIN) {
        page = pdf.addPage([PAGE.width, PAGE.height]);
        y = PAGE.height - MARGIN;
      }
      page.drawText(line, {
        x: MARGIN,
        y,
        size: heading ? SIZE + 2 : SIZE,
        font: heading ? bold : font,
        color: rgb(0, 0, 0),
      });
      y -= heading ? LEADING + 4 : LEADING;
    }
  }
}

/** The signed copy: the original with its audit page, or the page alone when it will not open. */
export async function buildSealedPdf(original: Uint8Array, input: StorageSealInput) {
  try {
    const pdf = await PDFDocument.load(original, { updateMetadata: false });
    await addAuditPages(pdf, input);
    return await pdf.save();
  } catch {
    const alone = await PDFDocument.create();
    await addAuditPages(alone, input);
    return alone.save();
  }
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface SealDeps {
  db: Db;
  bucket: R2Bucket;
  config: Config;
  email: SendEmail;
  log: Logger;
}

/**
 * Seals one request if it is completed and unsealed: builds the copy, writes it to this run's key,
 * records it, and on the run that recorded it mails every party; a run that lost deletes its copy. Answers the new file, or null
 * when there was nothing to do.
 */
export const sealSignatureRequest: (
  deps: SealDeps,
  requestId: string,
) => Promise<StorageNode | null> = async (deps, requestId) => {
  const input = await storageSealInput(deps.db, requestId);
  if (!input) return null;
  const object = await deps.bucket.get(input.r2Key);
  if (!object) {
    deps.log.error("storage.seal_original_missing", { requestId });
    return null;
  }
  const sealed = await buildSealedPdf(new Uint8Array(await object.arrayBuffer()), input);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", sealed));
  await deps.bucket.put(input.sealedR2Key, sealed, {
    httpMetadata: { contentType: "application/pdf" },
  });
  const recorded = await recordStorageSeal(deps.db, requestId, {
    r2Key: input.sealedR2Key,
    size: sealed.byteLength,
    sha256,
  }).catch(async (error: unknown) => {
    await dropUnrecorded(deps, requestId, input.sealedR2Key);
    throw error;
  });
  if (recorded.status !== "sealed") {
    await deps.bucket.delete(input.sealedR2Key);
    return null;
  }
  deps.log.info("storage.sealed", { requestId, orgId: recorded.node.orgId });
  await mailParties(deps, input, recorded.node);
  return recorded.node;
};

async function dropUnrecorded(deps: SealDeps, requestId: string, r2Key: string) {
  try {
    const kept = await sealedObject(deps.db, requestId);
    if (kept?.r2Key !== r2Key) await deps.bucket.delete(r2Key);
  } catch (error) {
    deps.log.warn("storage.seal_candidate_left", { requestId, r2Key, error });
  }
}

async function mailParties(deps: SealDeps, input: StorageSealInput, node: StorageNode) {
  const { config, log } = deps;
  if (!config.SYSTEM_MAIL_FROM) {
    log.warn("storage.seal_mail_skipped", { reason: "SYSTEM_MAIL_FROM is not set" });
    return;
  }
  const send = systemMailSender({ email: deps.email, config, log });
  const link = new URL(`/sign/${input.request.id}`, config.auth.webAppURL).toString();
  const subject = `"${input.fileName}" is signed`;
  for (const signer of input.request.signers) {
    await send({
      to: signer.email,
      subject,
      text: [
        `Everyone has signed "${input.fileName}" for ${input.workspaceName}.`,
        "",
        "Download the signed copy, with its signature certificate, here:",
        "",
        link,
        "",
        `Sign in with ${signer.email} to open it.`,
      ].join("\n"),
    });
  }
  if (input.sentBy) {
    await send({
      to: input.sentBy,
      subject,
      text: [
        `Everyone has signed "${input.fileName}".`,
        "",
        `The signed copy, "${node.name}", is beside the original in ${input.workspaceName}'s Drive, locked.`,
      ].join("\n"),
    });
  }
}

/** The every-minute backstop: seals what the run after the last signature did not. */
export function sealSignatures(env: Env) {
  const log = createLogger({ component: "storage", requestId: crypto.randomUUID() });
  const config = loadConfig(env);
  return runJob(
    Effect.gen(function* () {
      const db = yield* scopedDb(env);
      const pending = yield* retried("unsealed_signatures", () => unsealedSignatureRequests(db));
      const deps = { db, bucket: env.STORAGE_BUCKET, config, email: env.EMAIL, log };
      for (const { id } of pending) {
        yield* retried("seal_signature", () => sealSignatureRequest(deps, id));
      }
    }),
  );
}

/**
 * After the last signature: seal now, after the response, on a client of its own (the request's
 * closes with the response), and tell the drive it changed.
 */
export function sealAfterResponse(
  c: Context<AppEnv>,
  requestId: string,
  announce: (node: StorageNode) => void,
) {
  const { db, close } = openDb(c.env, 2);
  const deps = {
    db,
    bucket: c.env.STORAGE_BUCKET,
    config: c.var.config,
    email: c.env.EMAIL,
    log: c.var.log,
  };
  c.executionCtx.waitUntil(
    sealSignatureRequest(deps, requestId)
      .then((node) => node && announce(node))
      .catch((error: unknown) => c.var.log.warn("storage.seal_deferred", { requestId, error }))
      .finally(() => close()),
  );
}
