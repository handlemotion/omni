import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appToast } from "./components/ui/toast.tsx";
import { routeOutsideLinks, routeTitleBarDrags } from "./lib/desktop.ts";
import { reloadForUpdate } from "./lib/failure.ts";
import { createQueryClient } from "./lib/query-client.ts";
import { resetSession } from "./lib/session.ts";
import { dropStartupResponses } from "./lib/startup-fetch.ts";
import { initErrorReporting } from "./lib/telemetry.ts";
import { createAppRouter } from "./router.ts";
import "./styles.css";

initErrorReporting();
routeOutsideLinks();
routeTitleBarDrags();

// A lazy chunk (a route, a preview) that fails to load is almost always a window older than the
// last deploy: its chunks are gone. Reload once for the current build (ADR 0046). Within a minute
// of the last reload the error goes on to the screen's error boundary instead of looping.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForUpdate()) event.preventDefault();
});

let resetting = false;
const queryClient = createQueryClient(
  () => {
    // Many queries can 401 at once; reset once. The guards then redirect to /login.
    if (resetting) return;
    resetting = true;
    void resetSession(queryClient, router).finally(() => {
      resetting = false;
    });
  },
  // Ten actions failing offline show one toast, not ten.
  (message, failure) => appToast.error(message, { id: `failure-${failure.kind}` }),
);
const router = createAppRouter(queryClient);

// The landing screen's code starts loading now, beside the session check its guards wait on,
// rather than once they pass.
for (const route of router.getMatchedRoutes(window.location.pathname)[0]) {
  router.loadRouteChunk(route)?.catch(() => {}); // The navigation retries and reports it.
}
// By the first screen's arrival its requests have all gone out: preloads left over are for a
// screen nobody opened (a sign-in page, a redirect) and must not answer later requests.
const stopDropping = router.subscribe("onResolved", () => {
  stopDropping();
  dropStartupResponses();
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

// Web Vitals go where errors go (Sentry, when the build has a DSN) or to the console in dev.
// Loaded after the first render, and not at all when neither applies.
if (import.meta.env.DEV || import.meta.env.VITE_SENTRY_DSN) {
  void import("./lib/web-vitals.ts").then((m) => m.reportWebVitals());
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
