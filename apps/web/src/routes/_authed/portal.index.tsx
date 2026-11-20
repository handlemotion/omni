import { createFileRoute } from "@tanstack/react-router";
import { PortalHome } from "../../components/portal/portal-pages.tsx";
import { portalProjectsQuery } from "../../lib/portal.ts";

export const Route = createFileRoute("/_authed/portal/")({
  loader: ({ context }) => void context.queryClient.prefetchQuery(portalProjectsQuery()),
  component: PortalHome,
});
