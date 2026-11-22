import { createFileRoute, redirect } from "@tanstack/react-router";
import { crmDealsSearch } from "../../../../lib/search-params.ts";

/** Deals and Projects are one page: the old Deals board's links open Projects, on the board. */
export const Route = createFileRoute("/_authed/$workspace/crm/deals/")({
  validateSearch: crmDealsSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/$workspace/crm/projects", params, search, replace: true });
  },
});
