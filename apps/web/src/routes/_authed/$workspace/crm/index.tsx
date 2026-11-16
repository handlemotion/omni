import { createFileRoute, redirect } from "@tanstack/react-router";
import { listSearch } from "../../../../lib/search-params.ts";

/** `/crm` is Companies. */
export const Route = createFileRoute("/_authed/$workspace/crm/")({
  validateSearch: listSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/$workspace/crm/companies", params, search });
  },
});
