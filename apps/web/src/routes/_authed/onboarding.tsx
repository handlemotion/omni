import { createFileRoute } from "@tanstack/react-router";
import { Onboarding } from "../../components/onboarding/onboarding.tsx";
import { requireOnboarding } from "../../lib/guards.ts";

// Signed in, member of an organization or not: setup creates one, or finishes the active one.
export const Route = createFileRoute("/_authed/onboarding")({
  beforeLoad: ({ context }) => requireOnboarding(context.queryClient),
  component: Onboarding,
});
