import { getSetCookie, storageAdapter } from "@better-auth/expo/client";
import { randomUUID } from "expo-crypto";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "./secure-store";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { STORAGE_PREFIX, auth } from "./api.ts";
import { config } from "./config.ts";
import { forgetDriveFiles } from "./drive-files.ts";
import { cancelUploads } from "./drive-uploads.ts";
import { persistOptions, queryClient } from "./query-client.ts";
import { resetCache } from "./workspace.ts";
import { storeWorkspaceId } from "./workspace-id.ts";

const storage = storageAdapter(SecureStore);
const COOKIE_KEY = `${STORAGE_PREFIX}_cookie`;

const STATES_KEY = `${STORAGE_PREFIX}_sign_in_states`;
const SIGN_IN_TTL_MS = 60 * 60 * 1000;
const MAX_SIGN_INS_IN_FLIGHT = 8;

type IssuedStates = [state: string, issuedAt: number][];

async function readStates() {
  const none: IssuedStates = [];
  try {
    const stored: unknown = JSON.parse((await SecureStore.getItemAsync(STATES_KEY)) ?? "[]");
    if (!Array.isArray(stored)) return none;
    return (stored as IssuedStates).filter(([, at]) => Date.now() - at < SIGN_IN_TTL_MS);
  } catch {
    return none;
  }
}

async function issueState() {
  const state = randomUUID();
  const states = (await readStates()).slice(-(MAX_SIGN_INS_IN_FLIGHT - 1));
  await SecureStore.setItemAsync(STATES_KEY, JSON.stringify([...states, [state, Date.now()]]));
  return state;
}

async function takeIssuedState(state: string) {
  const states = await readStates();
  const rest = states.filter(([issued]) => issued !== state);
  await SecureStore.setItemAsync(STATES_KEY, JSON.stringify(rest));
  return rest.length < states.length;
}

/**
 * Opens the server's sign-in page in a browser sheet (`ASWebAuthenticationSession`), as the
 * desktop app hands sign-in to the browser. Every method there ends on this app's scheme with the
 * session as `cookie` (Better Auth's `expo` plugin): Google inside the sheet, which hands the
 * redirect back here; a magic link from the mail app, which opens the app itself
 * (`useSignInLinks`). The sheet is ephemeral, so a browser already signed in to the web app
 * still shows the sign-in page. Resolves `true` once signed in, `"error"` for a refused sign-in,
 * `false` when the person closed the sheet.
 */
export async function signInInBrowser() {
  const callback = Linking.createURL("/", { queryParams: { state: await issueState() } });
  const page = new URL("/login", config.apiUrl);
  page.searchParams.set("callback", callback);
  const result = await WebBrowser.openAuthSessionAsync(page.toString(), callback, {
    preferEphemeralSession: true,
  });
  return result.type === "success" ? acceptSignInLink(result.url) : (false as const);
}

/**
 * Takes the session out of a sign-in redirect this app started. Returns `true` when `url` carried
 * one, `"error"` when the sign-in was refused (an expired or used link, a cancelled consent),
 * `false` for any other URL, including one with a state this app did not issue or already used.
 */
export const acceptSignInLink: (url: string) => Promise<boolean | "error"> = async (url) => {
  const { queryParams } = Linking.parse(url);
  const state = queryParams?.state;
  if (typeof state !== "string" || !(await takeIssuedState(state))) return false;
  if (typeof queryParams?.error === "string") return "error";
  const setCookie = queryParams?.cookie;
  if (typeof setCookie !== "string" || !setCookie) return "error";
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
