import {
  forMember,
  oauthClientName,
  schema,
  type StorageContext,
  type StoragePlace,
} from "@omni/db";
import { z } from "zod";
import type { WriteDeps } from "../storage/doc-write.ts";
import type { ToolContext } from "./server.ts";

/** Where a new file goes: a folder, or a workspace's My files or Shared. */
export const placeInput = {
  folder_id: z.string().min(1).optional().describe("A folder to put it in, from `drive_list`."),
  workspace: z.string().min(1).optional().describe("A workspace id, without `folder_id`."),
  space: z
    .enum(["my_files", "shared"])
    .default("my_files")
    .describe("Without `folder_id`: the person's My files (default), or the company's Shared."),
};

/** The person writing, as a member of the workspace the file is in. */
export interface Writer {
  files: ReturnType<typeof forMember>["storage"];
  orgId: string;
  memberId: string;
}

/** What the Worker's file writes need, naming the agent so its versions say so. */
export const writeDeps = async (context: ToolContext) =>
  ({
    env: context.env,
    db: context.db,
    config: context.config,
    log: context.log,
    waitUntil: context.waitUntil,
    agent: await oauthClientName(context.db, context.caller.clientId),
  }) satisfies WriteDeps;

/** The person as a member of `orgId`; null when they are not one. */
export async function writerIn(context: ToolContext, drive: StorageContext, orgId: string) {
  const member = (await drive.workspaces()).find((w) => w.id === orgId);
  if (!member) return null;
  const writer: Writer = {
    files: forMember(context.db, member.memberId).storage,
    orgId,
    memberId: member.memberId,
  };
  return writer;
}

/** The place a new file goes, or why there is none. */
export async function placeFor(
  drive: StorageContext,
  input: { folder_id?: string; space: "my_files" | "shared" },
  workspace: string | undefined,
) {
  if (input.folder_id) {
    const [folder] = await drive.read([input.folder_id]);
    if (!folder || folder.node.kind !== "folder" || folder.via !== "member") {
      return { error: "No folder with that id in your workspaces' drives. Use `drive_list`." };
    }
    const place: StoragePlace = { parentId: folder.node.id };
    return { place, orgId: folder.workspace.id };
  }
  const workspaces = await drive.workspaces();
  const chosen = workspace
    ? workspaces.find((w) => w.id === workspace)
    : workspaces.length === 1
      ? workspaces[0]
      : undefined;
  if (!chosen) {
    return {
      error: `Name a \`workspace\`: ${workspaces.map((w) => `${w.name} (${w.id})`).join(", ")}.`,
    };
  }
  if (input.space === "shared" && chosen.personal) {
    return { error: "A personal workspace has no Shared drive. Use `my_files`." };
  }
  const place: StoragePlace = { space: input.space === "shared" ? "shared" : "personal" };
  return { place, orgId: chosen.id };
}

/** Why a write cannot happen now (the rate limit), or null. */
export async function ready(context: ToolContext, _orgId: string) {
  const wait = await context.rateLimit("actions");
  if (wait) return `Too many changes. Try again in ${wait} seconds.`;
  return null;
}

/** Records an agent's write in the workspace's audit log. */
export async function audit(
  context: ToolContext,
  writer: Writer,
  action: string,
  subject: string,
  kind: string,
) {
  await context.db.insert(schema.auditEvents).values({
    orgId: writer.orgId,
    actorMemberId: writer.memberId,
    action,
    subject,
    data: { via: "mcp", clientId: context.caller.clientId, kind },
  });
}
