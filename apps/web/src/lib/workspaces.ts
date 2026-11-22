import { WORKSPACE_HEADER } from "@omni/client";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, auth, call } from "./api.ts";
import { currentWorkspaceId, setCurrentWorkspaceId } from "./current-workspace.ts";
import { needsSetup } from "./onboarding.ts";
import { keys } from "./query-keys.ts";
import { authCall, sessionQuery } from "./session.ts";
import { cancelUploads } from "./storage-uploads.ts";
import type { Member, Workspace, Workspaces } from "./types.ts";

/**
 * `{ activeOrganizationId, workspaces }`: every org the user belongs to with its setup step and
 * the mailboxes they can open there.
 */
export const workspacesQuery = () =>
  queryOptions({
    queryKey: keys.workspaces(),
    queryFn: ({ signal }) =>
      call(
        api.workspaces.$get(
          { query: { include: "personal", personal: "on-demand" } },
          { init: { signal } },
        ),
      ),
  });

/**
 * The workspace list, read again when the cached one lacks what is asked for: a workspace made,
 * joined or renamed since it was read must not send its URL away.
 */
export async function workspacesWith(client: QueryClient, has: (data: Workspaces) => boolean) {
  const cached = await client.ensureQueryData(workspacesQuery());
  return has(cached) ? cached : client.fetchQuery({ ...workspacesQuery(), staleTime: 0 });
}

/**
 * The workspace a URL's first segment names, by slug. `/inbox` and the other paths from before
 * workspaces were in the URL name none, so they are sent on under one (`legacyPath`).
 */
export function workspaceBySlug(data: Workspaces, slug: string) {
  return data.workspaces.find((workspace) => workspace.slug === slug);
}

/** The workspace whose member can open `mailboxId`, if the user has one. */
export function workspaceOfMailbox(data: Workspaces, mailboxId: string) {
  return data.workspaces.find((workspace) => workspace.mailboxes.some((m) => m.id === mailboxId));
}

/** `href` (`/<slug>/…`) with its workspace segment replaced by `slug`. */
export function inOtherWorkspace(href: string, slug: string) {
  return href.replace(/^\/[^/?#]*/, `/${encodeURIComponent(slug)}`);
}

/** The workspace the app opens to: the session's, else the first. */
export function homeWorkspace(data: Workspaces) {
  return (
    data.workspaces.find((workspace) => workspace.id === data.activeOrganizationId) ??
    data.workspaces[0]
  );
}

/** `/<slug>/mail/inbox`: where `/` and a workspace's own root land. */
export const workspaceHome = (slug: string) => workspaceHref(slug, "/mail/inbox");

const MAIL = new Set(["inbox", "later", "done", "archive", "all", "search", "compose"]);
const MAIL_MORE = new Set(["drafts", "sent", "spam", "trash"]);

/**
 * A path from before workspaces were in the URL (`/inbox/<id>`, `/files/my`, `/settings`), put
 * under `slug`: mail's lists move under `/mail`. Null when `pathname` is no such path.
 */
export function legacyPath(slug: string, pathname: string) {
  const [first = ""] = pathname.split("/").filter(Boolean);
  const prefix = `/${encodeURIComponent(slug)}`;
  if (MAIL.has(first) || MAIL_MORE.has(first)) return `${prefix}/mail${pathname}`;
  if (["files", "crm", "calendar", "meetings", "settings"].includes(first))
    return `${prefix}${pathname}`;
  return null;
}

const memberIn = (workspaceId: string) => [...keys.root, "member-in", workspaceId] as const;

/**
 * Reads the user's member in each of `workspaces` other than this tab's, so switching to one shows
 * it at once (`enterWorkspace`). Cleared with the cache on sign-out and account switches.
 */
export function warmWorkspaces(client: QueryClient, workspaces: readonly Pick<Workspace, "id">[]) {
  for (const workspace of workspaces) {
    if (workspace.id === currentWorkspaceId()) continue;
    void client
      .prefetchQuery({
        queryKey: memberIn(workspace.id),
        staleTime: 5 * 60_000,
        queryFn: ({ signal }) =>
          call(
            api.me.$get(
              { query: { personal: "on-demand" } },
              { headers: { [WORKSPACE_HEADER]: workspace.id }, init: { signal } },
            ),
          ),
      })
      .catch(() => undefined);
  }
}

let activating: Promise<void> = Promise.resolve();

/**
 * Makes `workspace` this tab's: every API call names it, and every workspace query key carries it
 * (`query-keys.ts`), so nothing cached for another workspace can show here, and coming back to one
 * is served from its cache. Uploads still running go: they would land in the workspace left. The
 * session's member is read again for this workspace; when this tab already knows it (it was here
 * before, or `warmWorkspaces` read it) it shows at once and is checked behind. The session's
 * active organization follows without holding the switch, so the next load's preloads and anything
 * that names no workspace (iOS, Better Auth's defaults) agree with this tab.
 *
 * True when this switched from another workspace, rather than opening the first one.
 */
export async function enterWorkspace(client: QueryClient, workspace: Pick<Workspace, "id">) {
  const before = currentWorkspaceId();
  if (before === workspace.id) return false;
  if (before) await cancelUploads();
  const session = await client.ensureQueryData(sessionQuery());
  if (session?.member) client.setQueryData(memberIn(session.member.orgId), session.member);
  setCurrentWorkspaceId(workspace.id);
  if (!session) return !!before;
  if (session.session.activeOrganizationId !== workspace.id) {
    activating = authCall(auth.organization.setActive({ organizationId: workspace.id })).then(
      () =>
        void client.setQueryData<Workspaces>(
          keys.workspaces(),
          (data) => data && { ...data, activeOrganizationId: workspace.id },
        ),
    );
    activating.catch(() => undefined);
  }
  if (session.member?.orgId === workspace.id) return !!before;
  // WARNING: a session read still out for the workspace left would answer with its member.
  await client.cancelQueries({ queryKey: keys.session(), exact: true });
  const fresh = client.fetchQuery({ ...sessionQuery(), staleTime: 0 });
  const known = client.getQueryData<Member>(memberIn(workspace.id));
  if (!known) {
    await fresh;
    return !!before;
  }
  client.setQueryData(keys.session(), { ...session, member: known });
  void fresh.catch(() => undefined);
  return !!before;
}

/** A router: navigates. */
interface Navigator {
  navigate(options: { href: string }): Promise<void>;
  state: { location: { pathname: string; search: object } };
}

/** Where the current URL is inside its workspace: `/mail/inbox/<id>` for `/<slug>/mail/inbox/<id>`. */
export function placeInWorkspace(pathname: string) {
  return `/${pathname.split("/").slice(2).join("/")}`;
}

const LISTS = ["/mail/inbox", "/mail/later", "/mail/done", "/mail/archive", "/mail/all"];
const FILE_PLACES = ["/files/my", "/files/shared", "/files/shared-with-me", "/files/trash"];
const CRM_PLACES = ["/crm/companies", "/crm/people", "/crm/projects", "/crm/deals"];

const under = (place: string, path: string) => place === path || place.startsWith(`${path}/`);

function samePlace(router: Navigator) {
  const place = placeInWorkspace(router.state.location.pathname);
  if (under(place, "/files")) return FILE_PLACES.find((p) => under(place, p)) ?? "/files/my";
  if (under(place, "/crm")) return CRM_PLACES.find((p) => under(place, p)) ?? "/crm/companies";
  if (under(place, "/settings")) return place;
  if (under(place, "/calendar")) return calendarPlace(router);
  if (under(place, "/meetings")) return "/meetings";
  return sameList(router, undefined);
}

function calendarPlace(router: Navigator) {
  const { date, view } = router.state.location.search as { date?: string; view?: string };
  const query = new URLSearchParams();
  if (date) query.set("date", date);
  if (view) query.set("view", view);
  return query.size ? `/calendar?${query}` : "/calendar";
}

function sameList(router: Navigator, mailbox: string | undefined) {
  const place = placeInWorkspace(router.state.location.pathname);
  const search = router.state.location.search as { lane?: string; view?: string };
  const list = LISTS.find((l) => under(place, l)) ?? "/mail/inbox";
  const lane = list === "/mail/inbox" && !search.view ? search.lane : undefined;
  const query = new URLSearchParams();
  if (mailbox) query.set("mailbox", mailbox);
  if (lane) query.set("lane", lane);
  return query.size ? `${list}?${query}` : list;
}

/** `place` (`/mail/inbox?lane=…`, `/files/my`) inside the workspace with this slug. */
export const workspaceHref = (slug: string, place: string) =>
  `/${encodeURIComponent(slug)}${place}`;

const at = (workspace: Pick<Workspace, "slug">, place: string) =>
  workspaceHref(workspace.slug, place);

/**
 * Opens the workspace: onboarding if you can finish its setup, else the same place in it.
 * Onboarding names no workspace, so the session's active organization must be this one first. Its
 * route makes it this tab's workspace (`enterWorkspace`).
 */
export async function openWorkspace(
  client: QueryClient,
  router: Navigator,
  workspace: Pick<Workspace, "id" | "slug" | "role" | "setup">,
) {
  if (needsSetup(workspace)) {
    await enterWorkspace(client, workspace);
    await activating;
    await router.navigate({ href: "/onboarding" });
    return;
  }
  await router.navigate({ href: at(workspace, samePlace(router)) });
}

/** Opens the same list for one of the workspace's mailboxes. */
export async function openMailbox(
  router: Navigator,
  target: { workspace: Pick<Workspace, "slug">; mailboxId: string },
) {
  await router.navigate({ href: at(target.workspace, sameList(router, target.mailboxId)) });
}
