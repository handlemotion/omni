// `/settings/billing` opens the settings dialog on the workspace's Billing page. It is where Stripe
// sends people back from Checkout (success through Better Auth's `/api/auth/subscription/success`,
// which syncs the plan first, and cancel directly) and from the customer portal, so the page they
// return to shows the plan as it is now. Closing the dialog here returns to the inbox.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { openSettings } from "../../../../hooks/use-settings-dialog.ts";
import { billingQuery } from "../../../../lib/billing.ts";

export const Route = createFileRoute("/_authed/_member/settings/billing")({
  loader: ({ context }) => context.queryClient.ensureQueryData(billingQuery()),
  component: OpenBilling,
});

function OpenBilling() {
  useEffect(() => openSettings("billing"), []);
  return null;
}
