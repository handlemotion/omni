import { QueryClient, focusManager } from "@tanstack/react-query";
import { AppState } from "react-native";
import { isAuthError } from "./api.ts";

// Coming back to the app counts as focus: stale lists refetch, as a browser tab does.
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener("change", (state) => {
    handleFocus(state === "active");
  });
  return () => subscription.remove();
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => !isAuthError(error) && count < 2,
    },
  },
});
