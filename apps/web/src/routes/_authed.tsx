import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireUser } from "../lib/guards.ts";

/** Every route below needs a signed-in user. */
export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => requireUser(context.queryClient, location),
  component: Outlet,
});
