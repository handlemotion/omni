// What one tool call may read (ADR 0029): the grant's workspace, or the one the call names when
// the grant reaches every workspace. Every read is `forUser` for the token's user, so membership is
// checked live on each call.
import { forUser } from "@omni/db";
import type { ToolContext } from "./server.ts";

export type Reads = ReturnType<typeof forUser>;

/** The reads for `workspace`, or an error sentence when the grant cannot reach it. */
export const readsFor: (
  context: ToolContext,
  workspace: string | undefined,
) => { reads: Reads; scope: string | null } | { error: string } = (context, workspace) => {
  const granted = context.caller.workspace;
  // A one-workspace grant always reads that workspace; any other value, empty included, is
  // refused rather than allowed to widen it.
  if (granted !== null) {
    if (workspace !== undefined && workspace !== granted) {
      return {
        error: "This connection only reaches one workspace. Leave `workspace` out to use it.",
      };
    }
    return { reads: forUser(context.db, context.caller.userId, granted), scope: granted };
  }
  // An empty id names no workspace; `forUser` would read it as every workspace.
  const scope = workspace || null;
  return { reads: forUser(context.db, context.caller.userId, scope), scope };
};

/** A mailbox named by id or address among those the reads can open; null when it is not one. */
export async function findMailbox(reads: Reads, idOrAddress: string) {
  const wanted = idOrAddress.toLowerCase();
  const mailboxes = await reads.listMailboxes();
  return mailboxes.find((m) => m.id === idOrAddress || m.address.toLowerCase() === wanted) ?? null;
}

export function unknownMailbox(idOrAddress: string) {
  return `No inbox "${idOrAddress}" you can open. Call \`inbox\` to list them.`;
}
