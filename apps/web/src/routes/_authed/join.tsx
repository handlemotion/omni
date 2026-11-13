import { createFileRoute, redirect } from "@tanstack/react-router";
import { Join } from "../../components/join/join.tsx";
import { joinQuery } from "../../lib/join.ts";
import { keys } from "../../lib/query-keys.ts";

/**
 * Ask to join the company a sign-in is scoped to (ADR 0024). With nothing to join (accepted, or
 * never scoped), the cached session is dropped and the inbox opens, whose guard reads it again.
 */
export const Route = createFileRoute("/_authed/join")({
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.fetchQuery(joinQuery());
    } catch {
      context.queryClient.removeQueries({ queryKey: keys.session() });
      throw redirect({ to: "/inbox" });
    }
  },
  component: Join,
});
