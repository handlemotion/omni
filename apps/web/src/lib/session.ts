// Who is signed in, and the transitions that change it (sign in, sign out, switch organization).
// Any change of identity clears the whole cache and reloads the routes, so no data from one
// member or organization is ever shown to another.
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, auth, call } from "./api.ts";
import { keys } from "./query-keys.ts";
import type { Member } from "./types.ts";

/** What Better Auth's client methods return. */
interface AuthResult<T> {
  data: T | null;
  error: { status: number; message?: string | undefined; statusText?: string } | null;
}

/** Unwraps a Better Auth client call, throwing `ApiError` on failure. */
export async function authCall<T>(request: Promise<AuthResult<T>>): Promise<T> {
  const { data, error } = await request;
  if (error) throw new ApiError(error.status, error.message || error.statusText || "auth error");
  return data as T;
}

type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.getSession>>["data"]>;

export interface Session {
  user: AuthSession["user"];
  session: AuthSession["session"];
  /** The member in the active organization; null when the user belongs to none yet. */
  member: Member | null;
}

/** The signed-in session, or null when signed out. Route guards read it from the cache. */
export const sessionQuery = () =>
  queryOptions({
    queryKey: keys.session(),
    queryFn: async ({ signal }): Promise<Session | null> => {
      const data = await authCall(auth.getSession({ fetchOptions: { signal } }));
      if (!data) return null;
      try {
        const member = await call(api.me.$get(undefined, { init: { signal } }));
        return { user: data.user, session: data.session, member };
      } catch (error) {
        // Signed in but not a member of any organization (yet): an invitation can fix that.
        if (error instanceof ApiError && error.status === 403) {
          return { user: data.user, session: data.session, member: null };
        }
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
  });

/** Something that can rerun route loaders: the router. */
interface Reloadable {
  invalidate(): Promise<void>;
}

/**
 * Forgets everything cached for the previous identity and reruns the route guards and loaders.
 * In-flight queries are aborted first so a late answer cannot land in the new cache.
 */
export async function resetSession(client: QueryClient, router: Reloadable) {
  await client.cancelQueries();
  client.clear();
  await router.invalidate();
}

/** Only same-origin paths: `?redirect=https://evil.example` must not become an open redirect. */
export function safeRedirect(to: string | undefined) {
  // `//host` and `/\host` are both protocol-relative to a browser.
  return to && /^\/(?![/\\])/.test(to) ? to : "/inbox";
}

/** Emails a sign-in link that returns to `redirect` (a same-origin path) or the inbox. */
export function signInWithMagicLink(email: string, redirect?: string) {
  return authCall(
    auth.signIn.magicLink({
      email,
      callbackURL: safeRedirect(redirect),
      errorCallbackURL: "/login?error=magic_link",
    }),
  );
}

/** Which sign-in methods this deployment offers beyond email and passkeys. */
export const signInMethodsQuery = () =>
  queryOptions({
    queryKey: keys.signInMethods(),
    queryFn: ({ signal }) => call(api["sign-in-methods"].$get(undefined, { init: { signal } })),
    // Server config: it changes only on a redeploy.
    staleTime: Infinity,
  });

/**
 * Leaves for Google's consent screen; Google returns through the Worker to `redirect` (a
 * same-origin path) or the inbox. A refused sign-in (no invitation, cancelled consent) comes back
 * to `/login?error=<code>`.
 */
export function signInWithGoogle(redirect?: string) {
  return authCall(
    auth.signIn.social({
      provider: "google",
      callbackURL: safeRedirect(redirect),
      errorCallbackURL: "/login",
    }),
  );
}

/** Signs in with a passkey, then drops the signed-out cache so the route guards see the session. */
export async function signInWithPasskey(client: QueryClient, router: Reloadable) {
  await authCall(auth.signIn.passkey());
  await resetSession(client, router);
}

export async function signOut(client: QueryClient, router: Reloadable) {
  await authCall(auth.signOut());
  await resetSession(client, router);
}

/** Accepts an invitation and switches into the organization it is for. */
export async function acceptInvitation(
  client: QueryClient,
  router: Reloadable,
  invitationId: string,
) {
  const accepted = await authCall(auth.organization.acceptInvitation({ invitationId }));
  await setActiveOrganization(client, router, accepted.invitation.organizationId);
}

export function rejectInvitation(invitationId: string) {
  return authCall(auth.organization.rejectInvitation({ invitationId }));
}

/** Every account signed in on this browser (Better Auth multi-session). */
export const deviceSessionsQuery = () =>
  queryOptions({
    queryKey: keys.deviceSessions(),
    queryFn: ({ signal }) =>
      authCall(auth.multiSession.listDeviceSessions({ fetchOptions: { signal } })),
  });

/** Makes another signed-in account the active one; its data replaces everything cached. */
export async function switchAccount(client: QueryClient, router: Reloadable, sessionToken: string) {
  await authCall(auth.multiSession.setActive({ sessionToken }));
  await resetSession(client, router);
}

/** Signs one account out of this browser. Revoking the active one resets like a sign-out. */
export async function revokeDeviceSession(
  client: QueryClient,
  router: Reloadable,
  sessionToken: string,
) {
  const active = client.getQueryData<Session | null>(keys.session())?.session.token;
  await authCall(auth.multiSession.revoke({ sessionToken }));
  if (sessionToken === active) await resetSession(client, router);
  else await client.invalidateQueries({ queryKey: keys.deviceSessions() });
}

export async function setActiveOrganization(
  client: QueryClient,
  router: Reloadable,
  organizationId: string,
) {
  await authCall(auth.organization.setActive({ organizationId }));
  await resetSession(client, router);
}
