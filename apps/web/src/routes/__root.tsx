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
import { WindowControls } from "../components/shell/window-controls.tsx";
import { ContextMenuHost } from "../components/ui/context-menu.tsx";
import { Toaster } from "../components/ui/toast.tsx";
import { SharedTooltip } from "../components/ui/tooltip.tsx";
import type { RouterContext } from "../router.ts";

declare module "react-aria-components" {
  interface RouterConfig {
    routerOptions: Omit<NavigateOptions, keyof ToOptions>;
  }
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
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
  const setup = useLocation({ select: (l) => l.pathname.startsWith("/onboarding") });
  return (
    <RouterProvider navigate={(href, options) => router.navigate({ ...options, href })}>
      <Outlet />
      <Toaster setup={setup} />
      <SharedTooltip />
      <ContextMenuHost />
      <WindowControls />
    </RouterProvider>
  );
}
