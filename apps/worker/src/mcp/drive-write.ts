import { forMember, oauthClientName, type StorageContext, type StoragePlace } from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "../billing.ts";
import type { WriteDeps } from "../storage/doc-write.ts";
import type { ToolContext } from "./server.ts";

/** Where a new file goes: a folder, or the top of a teamspace. */
export const placeInput = {
  folder_id: z.string().min(1).optional().describe("A folder to put it in, from `drive_list`."),
  workspace: z.string().min(1).optional().describe("One workspace id: look only there."),
  teamspace_id: z
    .string()
    .min(1)
    .optional()
    .describe("Without `folder_id`: a teamspace id from `drive_list`, to put it at its top."),
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
  input: { folder_id?: string; teamspace_id?: string },
) {
  if (input.folder_id) {
    const [folder] = await drive.read([input.folder_id]);
    if (!folder || folder.node.kind !== "folder" || folder.via !== "member") {
      return { error: "No folder with that id in your workspaces' drives. Use `drive_list`." };
    }
    const place: StoragePlace = { parentId: folder.node.id };
    return { place, orgId: folder.workspace.id };
  }
  const teamspace = input.teamspace_id
    ? (await drive.teamspaces()).find((t) => t.id === input.teamspace_id)
    : undefined;
  if (!teamspace) {
    return {
      error:
        "Name a `folder_id`, or a `teamspace_id` to put it at the top of a teamspace. Both come from `drive_list`.",
    };
  }
  const place: StoragePlace = { teamspaceId: teamspace.id };
  return { place, orgId: teamspace.orgId };
}

/** Why a write cannot happen now (the rate limit, an unpaid plan), or null. */
export async function ready(context: ToolContext, orgId: string, changes = 1) {
  const wait = await context.rateLimit("actions", changes);
  if (wait) return `Too many changes. Try again in ${wait} seconds.`;
  if (!(await inGoodStanding(context.db, context.config, orgId))) {
    return "This workspace is read-only until its plan is paid.";
  }
  return null;
}
