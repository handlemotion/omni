import {
  forUser,
  type CommentDoor,
  type ContextNode,
  type ContextRead,
  type StorageComment,
  type StorageContext,
} from "@omni/db";
import { z } from "zod";
import { isDocFile } from "@omni/docs";
import { notifyMembers, realtimeOf } from "../realtime-announce.ts";
import { s2Basin } from "../s2.ts";
import { LiveFile } from "../storage/doc-live.ts";
import { writerIn } from "./drive-write.ts";
import type { ToolContext } from "./server.ts";

const replySchema = z.object({
  id: z.string(),
  by: z.string().describe("Who wrote it."),
  at: z.string(),
  text: z.string(),
});

export const threadSchema = replySchema.extend({
  on: z
    .string()
    .optional()
    .describe('What it points at: "page 3", "lines 4-9", "cell B3", or the passage quoted.'),
  resolved: z.boolean().optional(),
  replies: z.array(replySchema).optional(),
});

export type Thread = z.infer<typeof threadSchema>;

const MAX_QUOTE = 200;

const columnName = (column: number) => {
  let name = "";
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
};

/** Where a thread points, in a few words; undefined for the whole file. */
export function anchorText(anchor: StorageComment["anchor"]) {
  switch (anchor?.kind) {
    case "pdf":
      return `page ${anchor.page}`;
    case "image":
      return "a part of the picture";
    case "lines":
      return anchor.start === anchor.end
        ? `line ${anchor.start}`
        : `lines ${anchor.start}-${anchor.end}`;
    case "cell":
      return `cell ${anchor.sheet ? `${anchor.sheet}!` : ""}${columnName(anchor.column)}${anchor.row}`;
    case "text":
      return anchor.quote.length > MAX_QUOTE
        ? `"${anchor.quote.slice(0, MAX_QUOTE)}…"`
        : `"${anchor.quote}"`;
    default:
      return undefined;
  }
}

const reply = (comment: StorageComment) => ({
  id: comment.id,
  by: comment.authorName ?? (comment.authorGuest ? "A guest" : "Someone who left"),
  at: comment.createdAt.toISOString(),
  text: comment.body,
});

/** Comments as threads, oldest first: each root with what it points at and its replies. */
export function threadsOf(comments: StorageComment[], includeResolved: boolean) {
  const replies = new Map<string, StorageComment[]>();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    replies.set(comment.parentId, [...(replies.get(comment.parentId) ?? []), comment]);
  }
  return comments
    .filter((comment) => !comment.parentId && (includeResolved || !comment.resolvedAt))
    .map((root) => {
      const on = anchorText(root.anchor);
      const under = replies.get(root.id) ?? [];
      return {
        ...reply(root),
        ...(on ? { on } : {}),
        ...(root.resolvedAt ? { resolved: true } : {}),
        ...(under.length ? { replies: under.map(reply) } : {}),
      } satisfies Thread;
    });
}

/**
 * The comment operations for a file the person reached: as a member of its workspace, or
 * through what was shared with them. Null when neither door opens it.
 */
export async function commentDoorFor(
  context: ToolContext,
  drive: StorageContext,
  found: ContextNode,
) {
  const door: CommentDoor | null =
    found.via === "member"
      ? ((await writerIn(context, drive, found.workspace.id))?.files ?? null)
      : forUser(context.db, context.caller.userId, context.caller.workspace).storage;
  return door;
}

const MAX_TEXT_BYTES = 1_000_000;

/**
 * The file's text as it is now, for finding a quoted passage: a doc's live document when people
 * have unsaved typing in it, else its bytes, else what the indexer read. Null for a file with no
 * text to quote (too large, or not text).
 */
export async function currentText(context: ToolContext, drive: StorageContext, found: ContextRead) {
  const { node } = found;
  const basin = s2Basin(context.config);
  if (basin && found.via === "member" && isDocFile(node.name, node.mimeType)) {
    const live = await LiveFile.open(basin, node.id, node.contentVersion).catch(() => null);
    if (live?.unsaved) return live.markdown;
  }
  const textual = isDocFile(node.name, node.mimeType) || (node.mimeType ?? "").startsWith("text/");
  if (textual && node.size <= MAX_TEXT_BYTES) {
    const files =
      found.via === "member"
        ? (await writerIn(context, drive, found.workspace.id))?.files
        : forUser(context.db, context.caller.userId, context.caller.workspace).storage;
    const file = files ? await files.file(node.id) : null;
    const object = file?.status === "ok" ? await context.env.STORAGE_BUCKET.get(file.r2Key) : null;
    if (object) return object.text();
  }
  return found.content?.status === "ok" ? found.content.text : null;
}

/** Tells the people a comment named, and the apps that have the file open, after the answer. */
export function announceComment(
  context: ToolContext,
  nodeId: string,
  notified: { orgId: string; memberIds: string[] },
) {
  context.waitUntil(
    Promise.all([
      notifyMembers(context.env, context.db, { ...notified, threadId: null, kind: "comment" }),
      realtimeOf(context.env, notified.orgId).commentsChanged(nodeId),
    ]).catch((error: unknown) => context.log.warn("mcp.drive_comment_announce_failed", { error })),
  );
}
