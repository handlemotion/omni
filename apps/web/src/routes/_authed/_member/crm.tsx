import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { crmStagesQuery } from "../../../lib/crm.ts";
import { workspacesQuery } from "../../../lib/workspaces.ts";

/**
 * The CRM (ADR 0036, ADR 0039): a company workspace's only. A Personal space has none (the API
 * answers `no_crm`), so its paths open the Inbox instead. The stages load here: every CRM screen
 * names them.
 */
export const Route = createFileRoute("/_authed/_member/crm")({
  beforeLoad: async ({ context }) => {
    const { workspaces, activeOrganizationId } =
      await context.queryClient.ensureQueryData(workspacesQuery());
    const active = workspaces.find((w) => w.id === activeOrganizationId);
    if (!active || active.kind === "personal") throw redirect({ to: "/inbox" });
  },
  loader: ({ context }) => void context.queryClient.prefetchQuery(crmStagesQuery()),
  component: Outlet,
});
