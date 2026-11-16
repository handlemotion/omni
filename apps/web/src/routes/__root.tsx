import {
  createRootRouteWithContext,
  Outlet,
  useLocation,
  useRouter,
  type NavigateOptions,
  type ToOptions,
} from "@tanstack/react-router";
import { RouterProvider } from "react-aria-components";
import { ErrorScreen, FullWindow, NotFoundState } from "../components/errors/error-screen.tsx";
import { Toaster } from "../components/ui/toast.tsx";
import { SharedTooltip } from "../components/ui/tooltip.tsx";
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
  // The whole window: the shell may be what failed.
  errorComponent: ({ error, reset }) => (
    <FullWindow>
      <ErrorScreen error={error} reset={reset} />
    </FullWindow>
  ),
  notFoundComponent: () => (
    <FullWindow>
      <NotFoundState />
    </FullWindow>
  ),
});

function Root() {
  const router = useRouter();
  // Setup's validation and failures toast in dorks' blue.
  const setup = useLocation({ select: (l) => l.pathname.startsWith("/onboarding") });
  return (
    <RouterProvider navigate={(href, options) => router.navigate({ ...options, href })}>
      <Outlet />
      <Toaster setup={setup} />
      <SharedTooltip />
    </RouterProvider>
  );
}
