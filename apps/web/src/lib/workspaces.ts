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

/** Files' places a workspace switch keeps: each space's top, never a folder of the one left. */
const FILE_PLACES = [
  "/files/my",
  "/files/shared",
  "/files/shared-with-me",
  "/files/trash",
] as const;
type FilePlace = (typeof FILE_PLACES)[number];

/** The CRM's lists a workspace switch keeps; a Personal space has none (its guard sends it on). */
const CRM_PLACES = ["/crm/companies", "/crm/people", "/crm/deals"] as const;
type CrmPlace = (typeof CRM_PLACES)[number];

/** A router: reruns loaders, and navigates. */
interface Navigator {
  invalidate(): Promise<void>;
  navigate(
    options:
      | { to: "/onboarding" }
      | { to: ListPath | FilePlace | CrmPlace; search?: { mailbox?: string; lane?: string } },
  ): Promise<void>;
  state: { location: { pathname: string; search: object } };
}

/**
 * Where a workspace switch lands: in Files, the same place at its top (a folder belongs to the
 * workspace left behind; `/files/shared` sends a Personal space on to My files itself), so the
 * module stays; in the CRM, the same list (a record belongs to the workspace left behind);
 * anywhere else, mail's same list.
 */
function samePlace(router: Navigator) {
  const { pathname } = router.state.location;
  if (pathname === "/files" || pathname.startsWith("/files/")) {
    const place = FILE_PLACES.find((p) => pathname === p || pathname.startsWith(`${p}/`));
    return { to: place ?? "/files/my", search: {} } as const;
  }
  if (pathname === "/crm" || pathname.startsWith("/crm/")) {
    const place = CRM_PLACES.find((p) => pathname === p || pathname.startsWith(`${p}/`));
    return { to: place ?? "/crm/companies", search: {} } as const;
  }
  return sameList(router, undefined);
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

/**
 * Switches to the workspace, then opens onboarding if you can finish its setup, else the same
 * place: the same list in mail, the same space in Files.
 */
export async function openWorkspace(
  client: QueryClient,
  router: Navigator,
  workspace: Pick<Workspace, "id" | "role" | "setup">,
) {
  const target = samePlace(router);
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
