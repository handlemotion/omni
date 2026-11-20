import { createFileRoute } from "@tanstack/react-router";
import { PortalProjectPage } from "../../components/portal/portal-pages.tsx";
import { portalProjectQuery } from "../../lib/portal.ts";

export const Route = createFileRoute("/_authed/portal/$id")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(portalProjectQuery(params.id)),
  component: Project,
});

function Project() {
  const { id } = Route.useParams();
  return <PortalProjectPage key={id} id={id} />;
}
