import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  type NavigateOptions,
  type ToOptions,
} from "@tanstack/react-router";
import { RouterProvider } from "react-aria-components";
import type { RouterContext } from "../router.ts";

// React Aria links (`href` on Intent UI's Link, SidebarItem, Menu items) navigate through the
// TanStack router instead of reloading the page.
declare module "react-aria-components" {
  interface RouterConfig {
    routerOptions: Omit<NavigateOptions, keyof ToOptions>;
  }
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: () => <p>Not found.</p>,
});

function Root() {
  const router = useRouter();
  return (
    <RouterProvider navigate={(href, options) => router.navigate({ ...options, href })}>
      <Outlet />
    </RouterProvider>
  );
}
