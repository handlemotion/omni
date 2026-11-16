import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { crmStagesQuery } from "../../../lib/crm.ts";

/**
 * The CRM (ADR 0036, ADR 0039): a company workspace's only. A Personal space has none (the API
 * answers `no_crm`), so its paths open the Inbox instead. The stages load here: every CRM screen
 * names them.
 */
export const Route = createFileRoute("/_authed/$workspace/crm")({
  beforeLoad: ({ context, params }) => {
    if (context.workspace.kind === "personal") {
      throw redirect({ to: "/$workspace/mail/inbox", params });
    }
  },
  loader: ({ context }) => void context.queryClient.prefetchQuery(crmStagesQuery()),
  component: Outlet,
});
