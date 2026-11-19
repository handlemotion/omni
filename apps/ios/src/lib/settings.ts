import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, auth, call, inWorkspace } from "./api.ts";
import { useMailboxes } from "./mail.ts";
import { keys } from "./query-keys.ts";
import { useWorkspace } from "./workspace.ts";

/** A mailbox's sync state, in the web's words (Settings, Accounts, Inboxes). */
export const INBOX_STATUS: Record<string, string> = {
  pending: "Starting to sync",
  active: "Syncing",
  error: "Can't sign in",
  disabled: "Paused",
};

/** One of your inboxes here: its label, the From name it sends under, and whether it's yours. */
export interface YourInbox {
  id: string;
  address: string;
  status: string;
  label: string | null;
  senderName: string | null;
  /** You own it, so you name it (the Worker allows only an owner). */
  owned: boolean;
}

/**
 * Your personal inboxes in this workspace, as the web's Inboxes settings list the hosted ones;
 * `undefined` while loading. Sender names come from the workspace list, the rest from mailboxes.
 */
export function useYourInboxes() {
  const { active } = useWorkspace();
  const mailboxes = useMailboxes();
  if (!active || !mailboxes.data) return undefined;
  const named = new Map(active.mailboxes.map((box) => [box.id, box]));
  return mailboxes.data
    .filter((m) => m.orgId === active.id && m.kind === "personal")
    .map((m) => ({
      id: m.id,
      address: m.address,
      status: m.status,
      label: named.get(m.id)?.label ?? m.label,
      senderName: named.get(m.id)?.senderName ?? null,
      owned: m.role === "owner",
    })) satisfies YourInbox[];
}

function useRefreshInboxes() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.mailboxes() }),
      client.invalidateQueries({ queryKey: keys.workspaces() }),
    ]);
}

/**
 * `mutate({ mailboxId, label, workspace })` names one of your inboxes ("Work"); null clears it.
 * `workspace` is `currentWorkspaceId()` when the person acts.
 */
export function useLabelMailbox() {
  const refresh = useRefreshInboxes();
  return useMutation({
    mutationFn: (vars: { mailboxId: string; label: string | null; workspace: string | null }) =>
      call(
        api.mailboxes[":id"].label.$put(
          { param: { id: vars.mailboxId }, json: { label: vars.label } },
          inWorkspace(vars.workspace),
        ),
      ),
    onSettled: refresh,
  });
}

/**
 * `mutate({ mailboxId, senderName, workspace })`: the From name one of your inboxes sends under.
 * `workspace` is `currentWorkspaceId()` when the person acts.
 */
export function useSenderName() {
  const refresh = useRefreshInboxes();
  return useMutation({
    mutationFn: (vars: {
      mailboxId: string;
      senderName: string | null;
      workspace: string | null;
    }) =>
      call(
        api.mailboxes[":id"]["sender-name"].$put(
          { param: { id: vars.mailboxId }, json: { senderName: vars.senderName } },
          inWorkspace(vars.workspace),
        ),
      ),
    onSettled: refresh,
  });
}

/**
 * `mutate(name)` renames you everywhere. The auth client refetches the session after
 * `/update-user`, so every screen showing your name follows.
 */
export function useUpdateName() {
  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await auth.updateUser({ name });
      if (error) throw new Error(error.message ?? "Your name could not be changed.");
    },
  });
}
