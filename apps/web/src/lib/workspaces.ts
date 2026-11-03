// The workspace and account switcher's data (`GET /api/workspaces`) and the moves it makes:
// open a workspace (onboarding while its setup is unfinished) or one of its mailboxes.
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { needsSetup } from "./onboarding.ts";
import { keys } from "./query-keys.ts";
import { sessionQuery, setActiveOrganization } from "./session.ts";
import type { Workspace } from "./types.ts";

/**
 * `{ activeOrganizationId, workspaces }`: every org the user belongs to with its setup step and
 * the mailboxes they can open there.
 */
export const workspacesQuery = () =>
  queryOptions({
    queryKey: keys.workspaces(),
    queryFn: ({ signal }) => call(api.workspaces.$get(undefined, { init: { signal } })),
  });

/** A router: reruns loaders, and navigates. */
interface Navigator {
  invalidate(): Promise<void>;
  navigate(
    options: { to: "/onboarding" } | { to: "/inbox"; search?: { mailbox: string } },
  ): Promise<void>;
}

/** Makes `orgId` the active organization unless it already is (switching resets the cache). */
async function activate(client: QueryClient, router: Navigator, orgId: string) {
  const session = await client.ensureQueryData(sessionQuery());
  if (session?.member?.orgId !== orgId) await setActiveOrganization(client, router, orgId);
}

/** Switches to the workspace, then opens onboarding if you can finish its setup, else the inbox. */
export async function openWorkspace(
  client: QueryClient,
  router: Navigator,
  workspace: Pick<Workspace, "id" | "role" | "setup">,
) {
  await activate(client, router, workspace.id);
  await router.navigate(needsSetup(workspace) ? { to: "/onboarding" } : { to: "/inbox" });
}

/** Switches to the mailbox's workspace if needed, then opens `/inbox?mailbox=<id>`. */
export async function openMailbox(
  client: QueryClient,
  router: Navigator,
  target: { workspaceId: string; mailboxId: string },
) {
  await activate(client, router, target.workspaceId);
  await router.navigate({ to: "/inbox", search: { mailbox: target.mailboxId } });
}
