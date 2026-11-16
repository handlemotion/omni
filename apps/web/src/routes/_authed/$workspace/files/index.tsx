import { createFileRoute, redirect } from "@tanstack/react-router";
import { listSearch } from "../../../../lib/search-params.ts";

/** `/files` is My files. */
export const Route = createFileRoute("/_authed/$workspace/files/")({
  validateSearch: listSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/$workspace/files/my", params, search });
  },
});
