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
    // With the user's Personal space (ADR 0024), each workspace saying its `kind`.
    queryFn: ({ signal }) =>
      call(api.workspaces.$get({ query: { include: "personal" } }, { init: { signal } })),
  });

/** The lists the sidebar links to. Switching mailbox or workspace keeps the one on screen. */
const LISTS = ["/inbox", "/later", "/done", "/archive", "/all"] as const;
type ListPath = (typeof LISTS)[number];

/** A router: reruns loaders, and navigates. */
interface Navigator {
  invalidate(): Promise<void>;
  navigate(
    options: { to: "/onboarding" } | { to: ListPath; search?: { mailbox?: string; lane?: string } },
  ): Promise<void>;
  state: { location: { pathname: string; search: object } };
}

/**
 * Where a switch lands: the same list (and Inbox lane) as now, scoped to `mailbox`. An open
 * thread, a shared inbox's helpdesk view and its tag belong to the mailbox left behind, so they
 * go; anywhere that is not a list opens the Inbox.
 */
function sameList(router: Navigator, mailbox: string | undefined) {
  const { pathname } = router.state.location;
  const search = router.state.location.search as { lane?: string; view?: string };
  const to = LISTS.find((list) => pathname === list || pathname.startsWith(`${list}/`));
  const lane = to === "/inbox" && !search.view ? search.lane : undefined;
  return { to: to ?? "/inbox", search: { mailbox, lane } } as const;
}

/** Makes `orgId` the active organization unless it already is (switching resets the cache). */
async function activate(client: QueryClient, router: Navigator, orgId: string) {
  const session = await client.ensureQueryData(sessionQuery());
  if (session?.member?.orgId !== orgId) await setActiveOrganization(client, router, orgId);
}

/** Switches to the workspace, then opens onboarding if you can finish its setup, else the same list. */
export async function openWorkspace(
  client: QueryClient,
  router: Navigator,
  workspace: Pick<Workspace, "id" | "role" | "setup">,
) {
  const target = sameList(router, undefined);
  await activate(client, router, workspace.id);
  await router.navigate(needsSetup(workspace) ? { to: "/onboarding" } : target);
}

/** Switches to the mailbox's workspace if needed, then opens the same list for that mailbox. */
export async function openMailbox(
  client: QueryClient,
  router: Navigator,
  target: { workspaceId: string; mailboxId: string },
) {
  const list = sameList(router, target.mailboxId);
  await activate(client, router, target.workspaceId);
  await router.navigate(list);
}
