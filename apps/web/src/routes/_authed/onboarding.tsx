import { createFileRoute } from "@tanstack/react-router";
import { Onboarding } from "../../components/onboarding/onboarding.tsx";
import { billingQuery } from "../../lib/billing.ts";
import { requireOnboarding } from "../../lib/guards.ts";

// Signed in, member of an organization or not: setup creates one, or finishes the active one.
export const Route = createFileRoute("/_authed/onboarding")({
  beforeLoad: ({ context }) => requireOnboarding(context.queryClient),
  // The plan page's prices, trial and current plan, ready before it opens (ADR 0015), so nothing
  // on it pops in late. Only a workspace that exists has a plan; a failure leaves the page to say.
  loader: async ({ context }) => {
    const status = await requireOnboarding(context.queryClient);
    if (status.billing.enabled && status.organization) {
      await context.queryClient.ensureQueryData(billingQuery()).catch(() => {});
    }
  },
  component: Onboarding,
});
