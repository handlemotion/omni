import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { classify, reloadForUpdate, reportFailure } from "./lib/failure.ts";
import { routeTree } from "./routeTree.gen.ts";

export interface RouterContext {
  queryClient: QueryClient;
}

function onRouteError(error: unknown) {
  const failure = classify(error);
  if (failure.kind === "stale_build" && reloadForUpdate()) return;
  reportFailure(failure);
}

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultOnCatch: onRouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
