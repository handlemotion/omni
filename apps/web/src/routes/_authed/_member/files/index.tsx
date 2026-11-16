import { createFileRoute, redirect } from "@tanstack/react-router";
import { listSearch } from "../../../../lib/search-params.ts";

/** `/files` is My files. */
export const Route = createFileRoute("/_authed/_member/files/")({
  validateSearch: listSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/files/my", search });
  },
});
