import { QueryClient, focusManager, onlineManager, type Query } from "@tanstack/react-query";
import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";
import { File, Paths } from "expo-file-system";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";
import { isAuthError } from "./api.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener("change", (state) => {
    handleFocus(state === "active");
  });
  return () => subscription.remove();
});

onlineManager.setEventListener((setOnline) => {
  const subscription = Network.addNetworkStateListener((state) => {
    setOnline(state.isConnected !== false);
  });
  return () => subscription.remove();
});

/** How long Drive's listings are kept, in memory and on disk, to browse with no network. */
export const OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => !isAuthError(error) && count < 2,
    },
  },
});

queryClient.setQueryDefaults(["drive"], { gcTime: OFFLINE_MAX_AGE_MS });

const LISTINGS = new Set(["personal", "shared", "folder", "sharedWithMe", "trash", "node"]);

/** Whether a query is a Drive listing (a space, a folder, Shared with me, Trash, a node). */
export const isOfflineListing = (query: Query) =>
  query.state.status === "success" &&
  query.queryKey[0] === "drive" &&
  typeof query.queryKey[1] === "string" &&
  LISTINGS.has(query.queryKey[1]);

const SAVE_MS = 1_000;

function fileListingPersister() {
  const file = new File(Paths.document, "drive-listings.json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: { workspace: string | null; client: PersistedClient } | undefined;
  return {
    persistClient: (client) => {
      latest = { workspace: currentWorkspaceId(), client };
      timer ??= setTimeout(() => {
        timer = undefined;
        file.write(JSON.stringify(latest));
      }, SAVE_MS);
    },
    restoreClient: () => {
      if (!file.exists) return undefined;
      try {
        const saved = JSON.parse(file.textSync()) as {
          workspace: string | null;
          client?: PersistedClient;
        };
        return saved.workspace && saved.workspace === currentWorkspaceId()
          ? saved.client
          : undefined;
      } catch {
        return undefined;
      }
    },
    removeClient: () => {
      clearTimeout(timer);
      timer = undefined;
      latest = undefined;
      if (file.exists) file.delete();
    },
  } satisfies Persister;
}

const keepNothing = {
  persistClient: () => undefined,
  restoreClient: () => undefined,
  removeClient: () => undefined,
} satisfies Persister;

/**
 * `PersistQueryClientProvider`'s options: Drive's listings only, for a week, in a file in the
 * app's documents written at most once a second. The file names the workspace its listings came
 * from and is restored at launch only in that same workspace, so one workspace's files never
 * show in another.
 */
export const persistOptions = {
  persister: Platform.OS === "web" ? keepNothing : fileListingPersister(),
  maxAge: OFFLINE_MAX_AGE_MS,
  dehydrateOptions: { shouldDehydrateQuery: isOfflineListing },
};
