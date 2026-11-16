// The workspace and account switcher: every workspace with its mailboxes, and opening either.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { threadQuery } from "../lib/mail-queries.ts";
import {
  openMailbox,
  inOtherWorkspace,
  openWorkspace,
  placeInWorkspace,
  workspaceBySlug,
  workspaceHref,
  workspacesQuery,
} from "../lib/workspaces.ts";
import type { Workspace } from "../lib/types.ts";

/**
 * `{ activeOrganizationId, workspaces: [{ id, name, slug, logo, role, setup, mailboxes:
 * [{ id, address, kind: "personal" | "shared" }] }] }`. Only workspaces the user belongs to, and
 * only mailboxes their member there was granted.
 */
export function useWorkspaces(options: { enabled?: boolean } = {}) {
  return useQuery({ ...workspacesQuery(), enabled: options.enabled ?? true });
}

/** The workspace this page's URL is in (`/<slug>/…`, ADR 0043); undefined outside one. */
export function useCurrentWorkspace() {
  const { workspace: slug } = useParams({ strict: false }) as { workspace?: string };
  const data = useWorkspaces().data;
  return data && slug ? workspaceBySlug(data, slug) : undefined;
}

/** The URL segment of this page's workspace, for links inside it. */
export function useWorkspaceSlug() {
  const { workspace } = useParams({ strict: false }) as { workspace?: string };
  if (!workspace) throw new Error("useWorkspaceSlug outside a workspace route");
  return workspace;
}

/**
 * For links written as paths: `href("/files/my")` is that place in this page's workspace, and
 * `place` is where this page is inside it (`/files/my` on `/<slug>/files/my`).
 */
export function useWorkspacePaths() {
  const workspace = useWorkspaceSlug();
  const { pathname } = useLocation();
  const href = useCallback((place: string) => workspaceHref(workspace, place), [workspace]);
  return { href, place: placeInWorkspace(pathname) };
}

/**
 * `mutate(workspace)` opens `/onboarding` when its setup is unfinished and you can finish it
 * (owner or admin), else the same place in the module on screen, in that workspace.
 */
export function useOpenWorkspace() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (workspace: Pick<Workspace, "id" | "slug" | "role" | "setup">) =>
      openWorkspace(client, router, workspace),
  });
}

/** `mutate({ workspace, mailboxId })` opens the same list for that mailbox, in its workspace. */
export function useOpenMailbox() {
  const router = useRouter();
  return useMutation({
    mutationFn: (target: { workspace: Pick<Workspace, "slug">; mailboxId: string }) =>
      openMailbox(router, target),
  });
}

/** Whether this page's workspace is the user's Personal space (ADR 0024). */
export function usePersonalWorkspace() {
  return useCurrentWorkspace()?.kind === "personal";
}

/**
 * A thread opened by link under another workspace than its own (a notification, an agent's link,
 * an old `/all/<id>`) moves to its own: the thread reads as its workspace's member whatever the
 * URL says, so the page around it must be that workspace's too (ADR 0043).
 */
export function useThreadInItsWorkspace() {
  const router = useRouter();
  const { threadId } = useParams({ strict: false }) as { threadId?: string };
  const current = useCurrentWorkspace();
  const workspaces = useWorkspaces().data;
  const orgId = useQuery({
    ...threadQuery(threadId ?? ""),
    enabled: !!threadId,
    select: (thread) => thread.orgId,
  }).data;
  const owner = orgId && workspaces?.workspaces.find((w) => w.id === orgId);
  const move = owner && current && owner.id !== current.id ? owner.slug : undefined;
  useEffect(() => {
    if (!move) return;
    void router.navigate({
      href: inOtherWorkspace(router.state.location.href, move),
      replace: true,
    });
  }, [move, router]);
}
