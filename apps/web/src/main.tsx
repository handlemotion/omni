import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./lib/query-client.ts";
import { resetSession } from "./lib/session.ts";
import { createAppRouter } from "./router.ts";
import "./styles.css";

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

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
