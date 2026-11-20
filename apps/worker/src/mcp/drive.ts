import { forUser, type ContextNode, type StorageContext, type StorageNode } from "@omni/db";
import { z } from "zod";
import type { ToolContext } from "./server.ts";

export const itemSchema = z.object({
  id: z.string().describe("The file or folder id, for `drive_fetch` or `drive_list`."),
  title: z.string().describe("Its name."),
  url: z.string().describe("Open it in Omni. Cite it when you answer."),
  kind: z.enum(["file", "folder"]),
  mime_type: z.string().nullable(),
  size: z.number().describe("Bytes; 0 for a folder."),
  modified_at: z.string(),
  workspace: z.string().describe("The workspace's name."),
  location: z
    .string()
    .describe('Where it is: "My files", "Shared" or "Shared with you", then its folders.'),
});

export type Item = z.infer<typeof itemSchema>;

const DRIVE_PATH = { personal: "my", shared: "shared" } as const;

/** Where a node opens in the web app: its folder with it open, or the link it was shared at. */
export function nodeUrl(webAppURL: string, found: ContextNode) {
  const { node, workspace } = found;
  if (found.via === "grant") {
    if (!found.shareId) return new URL("/files/shared-with-me", webAppURL).toString();
    const url = new URL(`/s/${encodeURIComponent(found.shareId)}`, webAppURL);
    const top = found.path[0]?.id;
    if (node.kind === "folder" && node.id !== top) url.searchParams.set("node", node.id);
    if (node.kind === "file" && node.id !== top) {
      if (node.parentId && node.parentId !== top) url.searchParams.set("node", node.parentId);
      url.searchParams.set("file", node.id);
    }
    return url.toString();
  }
  const drive = `/${encodeURIComponent(workspace.slug)}/files/${DRIVE_PATH[node.space]}`;
  if (node.kind === "folder") {
    return new URL(`${drive}/${encodeURIComponent(node.id)}`, webAppURL).toString();
  }
  const folder = node.parentId ? `/${encodeURIComponent(node.parentId)}` : "";
  const url = new URL(`${drive}${folder}`, webAppURL);
  url.searchParams.set("file", node.id);
  return url.toString();
}

function locationOf(found: ContextNode) {
  const drive =
    found.via === "grant"
      ? "Shared with you"
      : found.node.space === "personal"
        ? "My files"
        : "Shared";
  const folders = found.path.slice(0, -1).map((entry) => entry.name);
  return [drive, ...folders].join(" / ");
}

/** A node the person reached through a door, as every Drive tool returns it. */
export function item(webAppURL: string, found: ContextNode) {
  return {
    id: found.node.id,
    title: found.node.name,
    url: nodeUrl(webAppURL, found),
    kind: found.node.kind,
    mime_type: found.node.mimeType,
    size: found.node.size,
    modified_at: found.node.updatedAt.toISOString(),
    workspace: found.workspace.name,
    location: locationOf(found),
  } satisfies Item;
}

/** A child listed inside a folder (or a drive) that the person reached as `parent`. */
export function child(webAppURL: string, parent: Omit<ContextNode, "node">, node: StorageNode) {
  const path = [...parent.path, { id: node.id, name: node.name }];
  return item(webAppURL, { ...parent, node, path });
}

/**
 * The Drive reads for this connection, or an error sentence when it names a workspace the grant
 * does not reach.
 */
export const driveFor: (
  context: ToolContext,
  workspace: string | undefined,
) => { drive: StorageContext; workspace: string | undefined } | { error: string } = (
  context,
  workspace,
) => {
  const granted = context.caller.workspace;
  if (granted !== null && workspace !== undefined && workspace !== granted) {
    return {
      error: "This connection only reaches one workspace. Leave `workspace` out to use it.",
    };
  }
  return {
    drive: forUser(context.db, context.caller.userId, granted).storage.context,
    workspace,
  };
};
