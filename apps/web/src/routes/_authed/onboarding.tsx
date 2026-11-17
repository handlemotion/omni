import { createFileRoute } from "@tanstack/react-router";
import { Onboarding } from "../../components/onboarding/onboarding.tsx";
import { billingQuery } from "../../lib/billing.ts";
import { leaveWorkspace } from "../../lib/current-workspace.ts";
import { requireOnboarding } from "../../lib/guards.ts";

export const Route = createFileRoute("/_authed/onboarding")({
  beforeLoad: ({ context, preload }) => {
    leaveWorkspace(preload);
    return requireOnboarding(context.queryClient);
  },
  loader: async ({ context }) => {
    const status = await requireOnboarding(context.queryClient);
    if (status.billing.enabled && status.organization) {
      await context.queryClient.ensureQueryData(billingQuery()).catch(() => {});
    }
  },
  component: Onboarding,
});
