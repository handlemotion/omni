// The workspace's plan (`GET /api/billing`, ADR 0015) and the two ways out to Stripe: Checkout to
// start the trial or subscribe, the customer portal to manage it. Both answer with a Stripe URL;
// the browser leaves the app for it and Stripe sends it back to /settings/billing.
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/**
 * `{ enabled: false }` on an install without billing. Otherwise the plan, whether the workspace
 * is read-only, and this period's AI triage against the allowance (`pausedUntil` once used up).
 */
export const billingQuery = () =>
  queryOptions({
    queryKey: keys.billing(),
    queryFn: ({ signal }) => call(api.billing.$get(undefined, { init: { signal } })),
  });

export const checkoutMutation = () =>
  mutationOptions({
    mutationFn: async (interval: "month" | "year") => {
      const { url } = await call(api.billing.checkout.$post({ json: { interval } }));
      window.location.assign(url);
    },
  });

export const portalMutation = () =>
  mutationOptions({
    mutationFn: async () => {
      const { url } = await call(api.billing.portal.$post());
      window.location.assign(url);
    },
  });
