import { getSetCookie, storageAdapter } from "@better-auth/expo/client";
import * as Linking from "expo-linking";
import * as SecureStore from "./secure-store";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { STORAGE_PREFIX, auth } from "./api.ts";
import { cancelUploads } from "./drive-uploads.ts";
import { queryClient } from "./query-client.ts";
import { storeWorkspaceId } from "./workspace-id.ts";

const storage = storageAdapter(SecureStore);
const COOKIE_KEY = `${STORAGE_PREFIX}_cookie`;

/** The callback a magic link ends on: the app's own root. */
export const SIGN_IN_CALLBACK = Linking.createURL("/");

/** Asks for a sign-in link; the person opens it from their mail on this phone. */
export async function requestSignInLink(email: string) {
  const { error } = await auth.signIn.magicLink({ email, callbackURL: SIGN_IN_CALLBACK });
  if (error) throw new Error(error.message ?? "could not send the link");
}

/**
 * Takes the session out of a sign-in redirect. Returns `true` when `url` carried one, `"error"`
 * when the link was refused (expired or used), `false` for any other URL.
 */
export const acceptSignInLink: (url: string) => Promise<boolean | "error"> = async (url) => {
  const { queryParams } = Linking.parse(url);
  if (typeof queryParams?.error === "string") return "error";
  const setCookie = queryParams?.cookie;
  if (typeof setCookie !== "string" || !setCookie) return false;
  const previous = await storage.getItemAsync(COOKIE_KEY);
  await storage.setItemAsync(COOKIE_KEY, getSetCookie(setCookie, previous ?? undefined));
  auth.$store.notify("$sessionSignal");
  return true;
};

export async function signOut() {
  await cancelUploads();
  await auth.signOut();
  await queryClient.cancelQueries();
  queryClient.clear();
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
 * here, elsewhere, or expired), so the next person never sees the last one's mail. Mount once.
 */
export function useClearCacheOnUserChange() {
  const userId = useSession().data?.user.id ?? null;
  const last = useRef(userId);
  useEffect(() => {
    if (last.current !== null && last.current !== userId) {
      void cancelUploads();
      void queryClient.cancelQueries();
      queryClient.clear();
      storeWorkspaceId(null);
    }
    last.current = userId;
  }, [userId]);
}
