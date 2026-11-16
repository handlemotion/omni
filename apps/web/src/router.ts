import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { classify, reloadForUpdate, reportFailure } from "./lib/failure.ts";
import { routeTree } from "./routeTree.gen.ts";

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Every failure a route's error boundary catches: its loader, its chunk, its render (ADR 0046).
 * A chunk from a build no longer deployed reloads once for the current one (the window's
 * `vite:preloadError` usually got there first); a bug or a 500 goes to Sentry.
 */
function onRouteError(error: unknown) {
  const failure = classify(error);
  if (failure.kind === "stale_build" && reloadForUpdate()) return;
  reportFailure(failure);
}

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    // Hovering or focusing a link runs its loader, which warms the query cache. TanStack Query
    // owns freshness, so the router never considers its own preload fresh.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    // Called by a route's error boundary (its `errorComponent`, or the default one) when it
    // catches; a route's own `onCatch` replaces it.
    defaultOnCatch: onRouteError,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
