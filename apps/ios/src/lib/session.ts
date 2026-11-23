import { useQuery } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, auth, call } from "./api.ts";
import { forgetDriveFiles } from "./drive-files.ts";
import { cancelUploads } from "./drive-uploads.ts";
import { persistOptions, queryClient } from "./query-client.ts";
import { resetCache } from "./workspace.ts";
import { storeWorkspaceId } from "./workspace-id.ts";

/**
 * Starts Google or Apple OAuth directly through Better Auth's Expo client: opens the provider's
 * consent screen in `ASWebAuthenticationSession` (never Omni's web login page), returns to
 * `omni://`, stores the session cookie in SecureStore, and notifies `useSession`.
 */
export async function signInWithSocial(provider: "google" | "apple") {
  const { error } = await auth.signIn.social({
    provider,
    callbackURL: Linking.createURL("/"),
    errorCallbackURL: Linking.createURL("/sign-in", { queryParams: { error: provider } }),
  });
  if (error) throw new Error(error.message || `Could not sign in with ${provider}`);
}

/** Sends a 6-digit sign-in code to `email`. */
export async function sendEmailOtp(email: string) {
  const { error } = await auth.emailOtp.sendVerificationOtp({
    email: email.trim(),
    type: "sign-in",
  });
  if (error) throw new Error(error.message || "Could not send code");
}

/** Verifies the 6-digit code natively and saves the session cookie into SecureStore. */
export async function verifyEmailOtp(email: string, otp: string) {
  const { error } = await auth.signIn.emailOtp({
    email: email.trim(),
    otp: otp.trim(),
  });
  if (error) throw new Error(error.message || "Invalid code");
}

/** Which optional OAuth providers (`google`, `apple`) this deployment has configured. */
export function useSignInMethods() {
  return useQuery({
    queryKey: ["sign-in-methods"],
    queryFn: ({ signal }) => call(api["sign-in-methods"].$get(undefined, { init: { signal } })),
    staleTime: Infinity,
  });
}

export async function signOut() {
  await cancelUploads();
  await auth.signOut();
  await queryClient.cancelQueries();
  queryClient.clear();
  forgetDriveFiles();
  persistOptions.persister.removeClient();
  storeWorkspaceId(null);
}

type SessionState = ReturnType<typeof auth.useSession.get>;

/** The signed-in user, `null` when signed out; `isPending` until the first answer. */
export function useSession() {
  return useSyncExternalStore(
    (listener) => auth.useSession.subscribe(listener),
    () => auth.useSession.get(),
  ) satisfies SessionState;
}

/**
 * Drops every cached query when the signed-in user changes or the session ends (signed out
 * here, elsewhere, or expired), so the next person never sees the last one's mail: a screen
 * still showing it is reset and asks again as them (`resetCache`). Mount once.
 */
export function useClearCacheOnUserChange() {
  const userId = useSession().data?.user.id ?? null;
  const last = useRef(userId);
  useEffect(() => {
    if (last.current !== null && last.current !== userId) {
      void cancelUploads();
      queryClient.getMutationCache().clear();
      forgetDriveFiles();
      persistOptions.persister.removeClient();
      resetCache(null);
    }
    last.current = userId;
  }, [userId]);
}
