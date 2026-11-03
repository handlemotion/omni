// Identity: the session, signing in and out, organizations, invitations.
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { invitationQuery, organizationsQuery } from "../lib/org-queries.ts";
import {
  acceptInvitation,
  deviceSessionsQuery,
  revokeDeviceSession,
  switchAccount,
  rejectInvitation,
  sessionQuery,
  setActiveOrganization,
  signInMethodsQuery,
  signInWithGoogle,
  signInWithMagicLink,
  signInWithPasskey,
  signOut,
} from "../lib/session.ts";

/** The session (user, session, member), or null when signed out. */
export function useSession() {
  return useQuery(sessionQuery());
}

/**
 * The signed-in user and their member in the active organization. Only for components under
 * the signed-in routes, whose guard has already loaded the session.
 */
export function useMember() {
  const { data } = useSuspenseQuery(sessionQuery());
  if (!data?.member) throw new Error("useMember() used outside the member routes");
  return { user: data.user, member: data.member };
}

/** `mutate({ email, redirect? })` emails a sign-in link that returns to `redirect`. */
export function useSignInMagicLink() {
  return useMutation({
    mutationFn: ({ email, redirect }: { email: string; redirect?: string | undefined }) =>
      signInWithMagicLink(email, redirect),
  });
}

/** `{ google }`: which optional sign-in methods this deployment has configured. */
export function useSignInMethods() {
  return useQuery(signInMethodsQuery());
}

/**
 * `mutate({ redirect? })` leaves for Google; after consent the browser lands on `redirect` (or
 * the inbox) signed in.
 */
export function useSignInGoogle() {
  return useMutation({
    mutationFn: ({ redirect }: { redirect?: string | undefined }) => signInWithGoogle(redirect),
  });
}

/** `mutate()` signs in with a passkey; on success, navigate to where the user was going. */
export function useSignInPasskey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => signInWithPasskey(),
    onSuccess: () => client.invalidateQueries({ queryKey: sessionQuery().queryKey }),
  });
}

/** `mutate()` signs out, clears every cached query, and reruns the route guards. */
export function useSignOut() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({ mutationFn: () => signOut(client, router) });
}

/** Organizations the user belongs to. */
export function useOrganizations() {
  return useQuery(organizationsQuery());
}

/** `mutate(organizationId)` switches organization: cache cleared, realtime reconnects. */
export function useSetActiveOrganization() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (organizationId: string) => setActiveOrganization(client, router, organizationId),
  });
}

/** The invitation shown on `/invite/$invitationId`. */
export function useInvitation(invitationId: string) {
  return useQuery(invitationQuery(invitationId));
}

/** `mutate(invitationId)` joins the organization and switches into it. */
export function useAcceptInvitation() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (invitationId: string) => acceptInvitation(client, router, invitationId),
  });
}

/** `mutate(invitationId)`. */
export function useRejectInvitation() {
  return useMutation({ mutationFn: (invitationId: string) => rejectInvitation(invitationId) });
}

/** Accounts signed in on this browser; add one by signing in again from `/login`. */
export function useDeviceSessions() {
  return useQuery(deviceSessionsQuery());
}

/** `mutate(sessionToken)` switches account: cache cleared, guards rerun, realtime reconnects. */
export function useSwitchAccount() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (sessionToken: string) => switchAccount(client, router, sessionToken),
  });
}

/** `mutate(sessionToken)` signs that account out of this browser. */
export function useRevokeDeviceSession() {
  const client = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: (sessionToken: string) => revokeDeviceSession(client, router, sessionToken),
  });
}
