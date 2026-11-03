import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./lib/query-client.ts";
import { resetSession } from "./lib/session.ts";
import { initErrorReporting } from "./lib/telemetry.ts";
import { createAppRouter } from "./router.ts";
import "./styles.css";

initErrorReporting();

let resetting = false;
const queryClient = createQueryClient(() => {
  // Many queries can 401 at once; reset once. The guards then redirect to /login.
  if (resetting) return;
  resetting = true;
  void resetSession(queryClient, router).finally(() => {
    resetting = false;
  });
});
const router = createAppRouter(queryClient);

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
