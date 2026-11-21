import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import { resetSession } from "./session.ts";

/** Every pending invitation to any of the signed-in person's verified sign-in emails. */
export const pendingInvitationsQuery = () =>
  queryOptions({
    queryKey: keys.pendingInvitations(),
    queryFn: ({ signal }) => call(api.invitations.$get(undefined, { init: { signal } })),
  });

/** One invitation by its link's id: pending, expired, accepted, declined, or wrong_account. */
export const invitationStatusQuery = (id: string) =>
  queryOptions({
    queryKey: keys.invitationStatus(id),
    queryFn: ({ signal }) =>
      call(api.invitations[":id"].$get({ param: { id } }, { init: { signal } })),
    retry: false,
  });

const SEEN = "omni.invitations-seen";

/**
 * The invitations screen comes first once per tab and account: someone in a workspace who leaves
 * it with "Not now" is not sent back to it on every load, and another account signed in to the
 * same tab still sees its own. Storage failing only shows it again.
 */
export const invitationsSeen = (userId: string) => {
  try {
    return sessionStorage.getItem(`${SEEN}:${userId}`) === "1";
  } catch {
    return false;
  }
};

export const markInvitationsSeen = (userId: string | undefined) => {
  if (!userId) return;
  try {
    sessionStorage.setItem(`${SEEN}:${userId}`, "1");
  } catch {}
};

/**
 * The pending invitations as the guards decide on them: a fresh read when `fresh`, else the
 * cached one. A failed read falls back to what is cached, so `/` and `/welcome` always agree,
 * and reads as none when nothing is: never block the app.
 */
export async function pendingInvitations(client: QueryClient, fresh = false) {
  const query = pendingInvitationsQuery();
  const read = fresh
    ? client.fetchQuery({ ...query, staleTime: 0 })
    : client.ensureQueryData(query);
  const data = await read.catch(() => client.getQueryData(query.queryKey) ?? null);
  return data?.invitations ?? [];
}

/** Whether `/` shows `userId`'s invitations first. */
export async function hasPendingInvitations(client: QueryClient, userId: string) {
  if (invitationsSeen(userId)) return false;
  return (await pendingInvitations(client)).length > 0;
}

/** Something that can rerun route loaders: the router. */
interface Reloadable {
  invalidate(): Promise<void>;
}

/** "Just me": makes the person's Personal space, opens it, and reruns the guards. Its slug. */
export async function chooseJustMe(client: QueryClient, router: Reloadable) {
  const { organization } = await call(api.onboarding.personal.$post());
  await resetSession(client, router);
  return organization.slug;
}
