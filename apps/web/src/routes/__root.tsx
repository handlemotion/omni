import {
  createRootRouteWithContext,
  Outlet,
  useLocation,
  useRouter,
  type NavigateOptions,
  type ToOptions,
} from "@tanstack/react-router";
import { RouterProvider } from "react-aria-components";
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
  notFoundComponent: () => <p>Not found.</p>,
});

function Root() {
  const router = useRouter();
  // Setup's validation and failures toast at the bottom right, in dorks' blue.
  const setup = useLocation({ select: (l) => l.pathname.startsWith("/onboarding") });
  return (
    <RouterProvider navigate={(href, options) => router.navigate({ ...options, href })}>
      <Outlet />
      {/* In the app, toasts stack over the floating Compose (or Reply and Forward) at the bottom
          right: 20px in like them, 12px above their 32px. Setup has no floating actions. */}
      <Toaster setup={setup} {...(!setup && { offset: { right: 20, bottom: 64 } })} />
      <SharedTooltip />
    </RouterProvider>
  );
}
