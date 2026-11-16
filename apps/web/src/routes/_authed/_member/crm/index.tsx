import { createFileRoute, redirect } from "@tanstack/react-router";
import { listSearch } from "../../../../lib/search-params.ts";

/** `/crm` is Companies. */
export const Route = createFileRoute("/_authed/_member/crm/")({
  validateSearch: listSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/crm/companies", search });
  },
});
