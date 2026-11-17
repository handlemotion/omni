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

window.addEventListener("vite:preloadError", (event) => {
  if (reloadForUpdate()) event.preventDefault();
});

let resetting = false;
const queryClient = createQueryClient(
  () => {
    if (resetting) return;
    resetting = true;
    void resetSession(queryClient, router).finally(() => {
      resetting = false;
    });
  },
  (message, failure) => appToast.error(message, { id: `failure-${failure.kind}` }),
);
const router = createAppRouter(queryClient);

for (const route of router.getMatchedRoutes(window.location.pathname)[0]) {
  router.loadRouteChunk(route)?.catch(() => {});
}
const stopDropping = router.subscribe("onResolved", () => {
  stopDropping();
  dropStartupResponses();
  hideLoadingScreen();
});

function hideLoadingScreen() {
  const screen = document.getElementById("app-loading");
  if (!screen) return;
  requestAnimationFrame(() => {
    screen.dataset.done = "";
    screen.addEventListener("transitionend", () => screen.remove(), { once: true });
    setTimeout(() => screen.remove(), 300);
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");

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
