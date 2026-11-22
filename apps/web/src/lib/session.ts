import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { forgetPdfTiles } from "./pdf-tile-cache.ts";
import { dropStartupResponses } from "./startup-fetch.ts";
import { api, ApiError, auth, call } from "./api.ts";
import { setCurrentWorkspaceId } from "./current-workspace.ts";
import { desktop } from "./desktop.ts";
import { keys } from "./query-keys.ts";
import { forgetOutstanding } from "./pending.ts";
import { cancelUploads } from "./storage-uploads.ts";
import type { Member } from "./types.ts";

/** What Better Auth's client methods return. */
interface AuthResult<T> {
  data: T | null;
  error: { status: number; message?: string | undefined; statusText?: string } | null;
}

/** Unwraps a Better Auth client call, throwing `ApiError` on failure. */
export async function authCall<T>(request: Promise<AuthResult<T>>) {
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
    queryFn: async ({ signal }) => {
      const me = call(api.me.$get({ query: { personal: "on-demand" } }, { init: { signal } })).then(
        (member) => ({ member }),
        (error: unknown) => ({ error }),
      );
      const data = await authCall(auth.getSession({ fetchOptions: { signal } }));
      if (!data) return null satisfies Session | null;
      const result = await me;
      if ("member" in result)
        return {
          user: data.user,
          session: data.session,
          member: result.member,
        } satisfies Session | null;
      const { error } = result;
      if (error instanceof ApiError && error.status === 403) {
        return { user: data.user, session: data.session, member: null } satisfies Session | null;
      }
      if (error instanceof ApiError && error.status === 401) return null satisfies Session | null;
      throw error;
    },
    staleTime: 5 * 60_000,
    networkMode: "always",
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
  const before = client.getQueryData<Session | null>(keys.session())?.user.id;
  await cancelUploads();
  dropStartupResponses();
  setCurrentWorkspaceId(undefined);
  await client.cancelQueries();
  client.clear();
  await router.invalidate();
  const after = client.getQueryData<Session | null>(keys.session())?.user.id;
  if (!after || after !== before) {
    forgetOutstanding();
    void forgetPdfTiles();
  }
}

/** Only same-origin paths: `?redirect=https://evil.example` must not become an open redirect. */
export function safeRedirect(to: string | undefined) {
  return to && /^\/(?![/\\])/.test(to) ? to : "/";
}

/**
 * Whether `to` is served by the Worker, not the app: an agent's sign-in returns to
 * `/api/auth/oauth2/authorize`. The app's router cannot open it; the browser must.
 */
export function isServerPath(to: string) {
  return to.startsWith("/api/");
}

async function nativeCallback(callback: string | undefined) {
  if (desktop.isDesktop) return desktop.signInCallback();
  if (!callback || !URL.canParse(callback)) return null;
  const { protocol } = new URL(callback);
  return /^(https?|javascript|data|blob|file|about|vbscript):$/i.test(protocol) ? null : callback;
}

/**
 * Emails a sign-in link that returns to `redirect` (a same-origin path) or the inbox. In the
 * desktop app the link opens in the browser, so it returns to the app through the shell's
 * `omni://` callback instead, success or failure; the window then reloads where it was. A phone
 * app's `callback` works the same way, without the reload.
 */
export async function signInWithMagicLink(email: string, redirect?: string, app?: string) {
  const callback = await nativeCallback(app);
  if (callback && desktop.isDesktop) rememberSignInRedirect(safeRedirect(redirect));
  return authCall(
    auth.signIn.magicLink({
      email,
      callbackURL: callback ?? safeRedirect(redirect),
      errorCallbackURL: callback ?? "/login?error=magic_link",
    }),
  );
}

const SIGN_IN_REDIRECT = "omni.sign-in-redirect";

function rememberSignInRedirect(to: string) {
  try {
    localStorage.setItem(SIGN_IN_REDIRECT, to);
  } catch {}
}

/** The destination a desktop sign-in started from, once; null when there is none. */
export function takeSignInRedirect() {
  try {
    const to = localStorage.getItem(SIGN_IN_REDIRECT);
    localStorage.removeItem(SIGN_IN_REDIRECT);
    return to && to !== "/" ? safeRedirect(to) : null;
  } catch {
    return null;
  }
}

/** Which sign-in methods this deployment offers beyond email and passkeys. */
export const signInMethodsQuery = () =>
  queryOptions({
    queryKey: keys.signInMethods(),
    queryFn: ({ signal }) => call(api["sign-in-methods"].$get(undefined, { init: { signal } })),
    staleTime: Infinity,
  });

/**
 * Leaves for Google's consent screen; Google returns through the Worker to `redirect` (a
 * same-origin path) or the inbox. A refused sign-in (no invitation, cancelled consent) comes back
 * to `/login?error=<code>`. In the desktop app the consent opens in the browser (Google refuses
 * embedded sign-in) through Better Auth's Expo proxy, which gives that browser the flow's state
 * cookie; the session comes back to the window through the shell's `omni://` callback, as a
 * magic link's does. A phone app's `callback` page is already in the browser, so Google returns
 * through the Worker straight to the app.
 */
export async function signInWithGoogle(redirect?: string, app?: string) {
  const callback = await nativeCallback(app);
  if (callback && !desktop.isDesktop) {
    return authCall(
      auth.signIn.social({ provider: "google", callbackURL: callback, errorCallbackURL: callback }),
    );
  }
  if (callback) {
    rememberSignInRedirect(safeRedirect(redirect));
    const { url } = await authCall(
      auth.signIn.social({
        provider: "google",
        callbackURL: callback,
        errorCallbackURL: callback,
        disableRedirect: true,
      }),
    );
    if (!url) throw new ApiError(500, "Google sign-in did not start");
    const proxy = new URL("/api/auth/expo-authorization-proxy", window.location.origin);
    proxy.searchParams.set("authorizationURL", url);
    desktop.openOutside(proxy.toString());
    return;
  }
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
  await cancelUploads();
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
  await cancelUploads();
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
  if (sessionToken === active) await cancelUploads();
  await authCall(auth.multiSession.revoke({ sessionToken }));
  if (sessionToken === active) await resetSession(client, router);
  else await client.invalidateQueries({ queryKey: keys.deviceSessions() });
}

export async function setActiveOrganization(
  client: QueryClient,
  router: Reloadable,
  organizationId: string,
) {
  await cancelUploads();
  await authCall(auth.organization.setActive({ organizationId }));
  await resetSession(client, router);
}

/** The signed-in user's sessions on every device, newest activity first (Better Auth `listSessions`). */
export const sessionsQuery = () =>
  queryOptions({
    queryKey: keys.sessions(),
    queryFn: async ({ signal }) => {
      const sessions = await authCall(auth.listSessions({ fetchOptions: { signal } }));
      return sessions.toSorted(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    },
  });

/** `mutate(sessionToken)` signs the user out on that device. Not for the current session. */
export const revokeSessionMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (token: string) => authCall(auth.revokeSession({ token })),
    onSettled: () => client.invalidateQueries({ queryKey: keys.sessions() }),
  });

/** `mutate()` signs the user out on every device but this one. */
export const revokeOtherSessionsMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: () => authCall(auth.revokeOtherSessions()),
    onSettled: () => client.invalidateQueries({ queryKey: keys.sessions() }),
  });

/**
 * `mutate(name)` changes the signed-in user's name. The session, the member list and the
 * accounts on this browser all show it, so they reload.
 */
export const updateNameMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (name: string) => authCall(auth.updateUser({ name })),
    onSuccess: () =>
      Promise.all([
        client.refetchQueries({ queryKey: keys.session() }),
        client.invalidateQueries({ queryKey: keys.deviceSessions() }),
        client.invalidateQueries({ queryKey: keys.members() }),
      ]),
  });
