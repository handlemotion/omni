import type { McpServer } from "@modelcontextprotocol/server";
import { isOmniCanvas } from "@omni/canvas";
import { baseMimeType, opensAsDoc, STORAGE_PART_BYTES } from "@omni/contracts";
import { signTransferKey, toBase64, type TransferGrant } from "@omni/crypto";
import { forUser, type ContextRead, type StorageContext } from "@omni/db";
import { isOmniSheet } from "@omni/sheets";
import { z } from "zod";
import { writeText } from "../../storage/doc-write.ts";
import { storageLimit } from "../../storage/core.ts";
import { STORAGE_TRANSFER_WHOLE_BYTES } from "../../storage/transfer.ts";
import { startObject, uploadCaps } from "../../storage/uploads.ts";
import { driveFor, item, itemSchema } from "../drive.ts";
import { placeFor, placeInput, ready, writeDeps, writerIn, type Writer } from "../drive-write.ts";
import { result, toolError } from "../format.ts";
import { guarded, recordMcpWrite, type ToolContext } from "../server.ts";

const INLINE_MAX_BYTES = 1_000_000;
const IMAGE_MAX_BYTES = 3_750_000;
const INLINE_CALL_BYTES = 5_000_000;
const MAX_IDS = 10;
const UPLOAD_LINK_MS = 60 * 60_000;
const DOWNLOAD_LINK_MS = 15 * 60_000;
const SHOWN_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

const typeOf = (name: string, given: string | undefined) =>
  given ?? TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const uploadInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe('A new file\'s name, with its extension ("report.pdf"). Not with `id`.'),
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A file to replace: the bytes become its next version (the old ones stay in its history).",
    ),
  ...placeInput,
  text: z
    .string()
    .max(INLINE_MAX_BYTES)
    .optional()
    .describe("The file's whole text, up to 1 MB: written at once."),
  base64: z
    .string()
    .max(Math.ceil(INLINE_MAX_BYTES / 3) * 4)
    .optional()
    .describe("The file's bytes in base64, up to 1 MB: written at once."),
  size: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Instead of text or base64: the file's size in bytes, for a link to send it from the machine you run on.",
    ),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe("With `size`: the bytes' hex sha256; Wok refuses bytes that do not match."),
  mime_type: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe("Its type; by default from the extension."),
});

type UploadInput = z.infer<typeof uploadInput>;

const linkSchema = z.object({
  url: z.string(),
  expires_at: z.string(),
  command: z.string().describe("A shell command that does it, with `curl`."),
});

const uploadOutput = z.object({
  file: itemSchema.optional().describe("The file written, when the bytes came in this call."),
  upload: linkSchema
    .extend({
      id: z.string(),
      size: z.number(),
      parts: z
        .object({
          part_bytes: z.number(),
          count: z.number(),
          put: z.string().describe("PUT each part to this url with ?part=1, 2, …"),
          complete: z.string().describe("Then POST to this url."),
        })
        .optional()
        .describe("For a file over 96 MB: send it in parts instead of one PUT."),
    })
    .optional()
    .describe("With `size`: PUT the bytes to `url`. Its answer is the file."),
});

const downloadInput = z.object({
  id: z.string().min(1).describe("A file id from `drive_search` or `drive_list`."),
  ids: z
    .array(z.string().min(1))
    .max(MAX_IDS - 1)
    .optional()
    .describe("More files, up to 10 in all."),
  inline: z
    .boolean()
    .default(false)
    .describe(
      "Also answer the bytes: pictures as images you can see (up to 3.75 MB), other files up to 1 MB as base64.",
    ),
});

const fileLinkSchema = linkSchema.extend({
  id: z.string(),
  title: z.string(),
  size: z.number(),
  mime_type: z.string().nullable(),
  web_url: z.string().describe("Open it in Wok."),
  base64: z.string().optional().describe("With `inline`: the bytes."),
});

const downloadOutput = z.object({
  files: z.array(fileLinkSchema),
  not_found: z.array(z.string()).optional(),
});

const REFUSED: Record<string, string> = {
  forbidden: "The person may not add or change files there.",
  not_found: "No file with that id you can change. Ids come from `drive_search` or `drive_list`.",
  locked: "That file is locked. Someone unlocks it in Wok first.",
  full: "The workspace's storage is full.",
  invalid_name: "That name cannot be a file's name.",
  name_taken: "Something there already has that name.",
  too_many_uploads: "Too many files are being written right now. Try again in a minute.",
  parent_trashed: "That folder is in the trash.",
  version_conflict: "The file changed while this ran. Read it again and retry.",
};

const refusal = (reason: string) =>
  toolError(REFUSED[reason] ?? "Wok could not write the file this time.");

const transferUrl = async (context: ToolContext, grant: TransferGrant) => {
  const key = await signTransferKey(context.config.auth.secret, grant);
  return new URL(`/api/storage/transfer/${key}`, context.config.auth.baseURL).toString();
};

const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const isLivePage = (found: ContextRead) =>
  opensAsDoc(found.node.name, found.node.mimeType) ||
  isOmniSheet(found.node.mimeType) ||
  isOmniCanvas(found.node.mimeType);

interface Target {
  writer: Writer;
  orgId: string;
  name: string;
  replace: { nodeId: string; ifContentVersion: number } | null;
  place: { parentId: string } | { teamspaceId: string } | null;
  mimeType: string;
}

async function targetOf(context: ToolContext, drive: StorageContext, input: UploadInput) {
  if (input.id) {
    if (input.name) return "Give `id` to replace a file, or `name` for a new one, not both.";
    const [found] = await drive.read([input.id]);
    if (found?.node.kind !== "file" || found.via !== "member") return REFUSED.not_found!;
    if (isLivePage(found)) {
      return "That is a Wok doc, sheet or canvas: change it with `drive_edit_doc`, `drive_edit_sheet` or `drive_edit_canvas`, which merge with what people are typing.";
    }
    const writer = await writerIn(context, drive, found.workspace.id);
    if (!writer) return REFUSED.forbidden!;
    const target: Target = {
      writer,
      orgId: found.workspace.id,
      name: found.node.name,
      replace: { nodeId: found.node.id, ifContentVersion: found.node.contentVersion },
      place: null,
      mimeType: input.mime_type ?? found.node.mimeType ?? typeOf(found.node.name, undefined),
    };
    return target;
  }
  if (!input.name) return "Name the new file (`name`), or give the `id` of one to replace.";
  const at = await placeFor(drive, input);
  if (!at.place) return at.error ?? "Name a folder or a teamspace.";
  const writer = await writerIn(context, drive, at.orgId);
  if (!writer) return REFUSED.forbidden!;
  const target: Target = {
    writer,
    orgId: at.orgId,
    name: input.name,
    replace: null,
    place: at.place as Target["place"],
    mimeType: typeOf(input.name, input.mime_type),
  };
  return target;
}

const bytesOf = (input: UploadInput) => {
  if (input.text !== undefined) return new TextEncoder().encode(input.text);
  const binary = atob(input.base64 ?? "");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

async function writeNow(
  context: ToolContext,
  drive: StorageContext,
  target: Target,
  input: UploadInput,
) {
  let bytes: Uint8Array;
  try {
    bytes = bytesOf(input);
  } catch {
    return toolError("`base64` is not valid base64.");
  }
  const where = target.replace ?? { place: target.place!, name: target.name };
  const written = await writeText(
    await writeDeps(context),
    target.writer.files,
    target.orgId,
    where,
    bytes,
    target.mimeType,
  );
  if (written.status === "version_conflict") return refusal("version_conflict");
  if (written.status !== "ok") return refusal(written.reason);
  await recordMcpWrite(context, target.writer, "mcp.drive_upload", written.node.id, {
    bytes: bytes.byteLength,
  });
  const [found] = await drive.read([written.node.id]);
  return found
    ? result({ file: item(context.webAppURL, found) })
    : toolError("The file was written, but it could not be opened again.");
}

async function openLink(
  context: ToolContext,
  target: Target,
  input: UploadInput & { size: number },
) {
  const { limitBytes } = await storageLimit(context.db, context.config, target.orgId);
  const agent = (await writeDeps(context)).agent;
  const file = {
    size: input.size,
    mimeType: target.mimeType,
    limitBytes,
    sha256: input.sha256 ?? null,
    caps: uploadCaps(context.config),
    agent,
  };
  const opened = target.replace
    ? await target.writer.files.openVersionUpload(target.replace.nodeId, {
        ...file,
        ifContentVersion: target.replace.ifContentVersion,
      })
    : await target.writer.files.openUpload(target.place!, { ...file, name: target.name });
  if (opened.status !== "ok") return refusal(opened.status);
  const upload = await startObject(context.env.STORAGE_BUCKET, target.writer.files, opened.upload);
  const expiresAt = new Date(Math.min(Date.now() + UPLOAD_LINK_MS, upload.expiresAt.getTime()));
  const url = await transferUrl(context, {
    kind: "put",
    subject: upload.id,
    userId: context.caller.userId,
    scope: context.caller.workspace,
    orgId: target.orgId,
    ifContentVersion: target.replace?.ifContentVersion ?? null,
    expiresAt,
  });
  await recordMcpWrite(context, target.writer, "mcp.drive_upload", upload.id, {
    bytes: input.size,
  });
  const whole = input.size <= STORAGE_TRANSFER_WHOLE_BYTES;
  const parts = Math.ceil(input.size / STORAGE_PART_BYTES);
  return result({
    upload: {
      id: upload.id,
      size: input.size,
      url,
      expires_at: expiresAt.toISOString(),
      command: whole
        ? `curl -sS --fail-with-body -T ${quoted(target.name)} ${quoted(url)}`
        : `for n in $(seq 1 ${parts}); do dd if=${quoted(target.name)} bs=${STORAGE_PART_BYTES} skip=$((n-1)) count=1 status=none | curl -sS --fail-with-body -T - "${url}?part=$n"; done && curl -sS --fail-with-body -X POST ${quoted(url)}`,
      ...(whole
        ? {}
        : { parts: { part_bytes: STORAGE_PART_BYTES, count: parts, put: url, complete: url } }),
    },
  });
}

async function upload(context: ToolContext, input: UploadInput) {
  const given = [input.text, input.base64, input.size].filter((x) => x !== undefined).length;
  if (given !== 1) return toolError("Give exactly one of `text`, `base64` or `size`.");
  const scoped = driveFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const target = await targetOf(context, scoped.drive, input);
  if (typeof target === "string") return toolError(target);
  const blocked = await ready(context, target.orgId);
  if (blocked) return toolError(blocked);
  if (input.size === undefined) return writeNow(context, scoped.drive, target, input);
  return openLink(context, target, { ...input, size: input.size });
}

async function bytesFor(context: ToolContext, found: ContextRead, drive: StorageContext) {
  const files =
    found.via === "member"
      ? (await writerIn(context, drive, found.workspace.id))?.files
      : forUser(context.db, context.caller.userId, context.caller.workspace).storage;
  const file = files ? await files.file(found.node.id) : null;
  const object = file?.status === "ok" ? await context.env.STORAGE_BUCKET.get(file.r2Key) : null;
  return object ? new Uint8Array(await object.arrayBuffer()) : null;
}

async function linkFor(context: ToolContext, found: ContextRead) {
  const expiresAt = new Date(Date.now() + DOWNLOAD_LINK_MS);
  const url = await transferUrl(context, {
    kind: "get",
    subject: found.node.id,
    userId: context.caller.userId,
    scope: context.caller.workspace,
    orgId: found.via === "member" ? found.workspace.id : null,
    ifContentVersion: null,
    expiresAt,
  });
  const shown = item(context.webAppURL, found);
  return {
    id: found.node.id,
    title: found.node.name,
    size: found.node.size,
    mime_type: found.node.mimeType,
    web_url: shown.url,
    url,
    expires_at: expiresAt.toISOString(),
    command: `curl -sS --fail-with-body -o ${quoted(found.node.name)} ${quoted(url)}`,
  };
}

async function download(context: ToolContext, input: z.infer<typeof downloadInput>) {
  const scoped = driveFor(context, undefined);
  if ("error" in scoped) return toolError(scoped.error);
  const wanted = [...new Set([input.id, ...(input.ids ?? [])])];
  const found = (await scoped.drive.read(wanted)).filter((hit) => hit.node.kind === "file");
  if (!found.length) {
    return toolError(
      "None of those ids is a file you can open. Ids come from `drive_search` or `drive_list`.",
    );
  }
  const files: z.infer<typeof fileLinkSchema>[] = await Promise.all(
    found.map((hit) => linkFor(context, hit)),
  );
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  let budget = INLINE_CALL_BYTES;
  for (const [i, hit] of found.entries()) {
    if (!input.inline) break;
    const type = baseMimeType(hit.node.mimeType);
    const cap = SHOWN_IMAGES.has(type) ? IMAGE_MAX_BYTES : INLINE_MAX_BYTES;
    if (hit.node.size > Math.min(cap, budget)) continue;
    const bytes = await bytesFor(context, hit, scoped.drive);
    if (!bytes) continue;
    budget -= bytes.byteLength;
    if (SHOWN_IMAGES.has(type))
      images.push({ type: "image", data: toBase64(bytes), mimeType: type });
    else files[i] = { ...files[i]!, base64: toBase64(bytes) };
  }
  const missing = wanted.filter((id) => !found.some((hit) => hit.node.id === id));
  const answer = result({ files, ...(missing.length ? { not_found: missing } : {}) });
  return { ...answer, content: [...answer.content, ...images] };
}

export function registerDriveTransfer(server: McpServer, context: ToolContext) {
  server.registerTool(
    "drive_upload",
    {
      title: "Upload a file",
      description:
        "Put a file into Drive, new (`name` and `folder_id` or `teamspace_id`) or as the next version of one (`id`). Up to 1 MB, give its `text` or `base64` and it is written now. From the machine you run on, any size: give `size` (and `sha256`) and run the `command` it answers, a `curl -T` to a link good for an hour; the PUT's answer is the file. Wok docs, sheets and canvases change through their edit tools instead.",
      inputSchema: uploadInput,
      outputSchema: uploadOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "drive_upload", () => upload(context, input)),
  );
  server.registerTool(
    "drive_download",
    {
      title: "Download files",
      description:
        "Get the bytes of up to 10 Drive files: each answers a link good for 15 minutes and a `curl` `command` that saves it on the machine you run on, under its name. With `inline`, pictures also come back as images you can look at, and other files up to 1 MB as base64. To read a file's text, `drive_fetch` is cheaper.",
      inputSchema: downloadInput,
      outputSchema: downloadOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "drive_download", () => download(context, input)),
  );
}
