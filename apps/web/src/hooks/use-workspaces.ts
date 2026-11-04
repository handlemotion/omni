// The workspace and account switcher: every workspace with its mailboxes, and opening either.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { openMailbox, openWorkspace, workspacesQuery } from "../lib/workspaces.ts";
import type { Workspace } from "../lib/types.ts";

/**
 * `{ activeOrganizationId, workspaces: [{ id, name, slug, logo, role, setup, mailboxes:
 * [{ id, address, kind: "personal" | "shared" }] }] }`. Only workspaces the user belongs to, and
 * only mailboxes their member there was granted.
 */
export function useWorkspaces(options: { enabled?: boolean } = {}) {
  return useQuery({ ...workspacesQuery(), enabled: options.enabled ?? true });
}

/**
 * Workspace names by org id, for rows that name their workspace, or undefined when the rows
 * cannot mix workspaces: one mailbox is chosen, or the user belongs to one workspace.
 */
export function useWorkspaceNames(mailbox?: string) {
  const workspaces = useWorkspaces().data?.workspaces;
  return useMemo(
    () =>
      !mailbox && workspaces && workspaces.length > 1
        ? new Map(workspaces.map((w) => [w.id, w.name]))
        : undefined,
    [mailbox, workspaces],
  );
}

/**
 * `mutate(workspace)` makes it active and opens `/onboarding` when its setup is unfinished and
 * you can finish it (owner or admin), else `/inbox`.
 */
export function useOpenWorkspace() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (workspace: Pick<Workspace, "id" | "role" | "setup">) =>
      openWorkspace(client, router, workspace),
  });
}

/** `mutate({ workspaceId, mailboxId })` switches workspace if needed and opens that mailbox's inbox. */
export function useOpenMailbox() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (target: { workspaceId: string; mailboxId: string }) =>
      openMailbox(client, router, target),
  });
}
