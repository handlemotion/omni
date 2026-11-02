import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { RouterContext } from "../router.ts";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => <p>Not found.</p>,
});
