// The workspace's plan and AI triage allowance, and the Stripe hand-offs (ADR 0014).
import { useMutation, useQuery } from "@tanstack/react-query";
import { billingQuery, checkoutMutation, portalMutation } from "../lib/billing.ts";

/** `{ enabled: false }` without billing; else plan, `readOnly`, `canManage` and `triage` usage. */
export function useBilling() {
  return useQuery(billingQuery());
}

/** `mutate("month" | "year")` leaves for Stripe Checkout (the trial, when the workspace has one). */
export function useStartCheckout() {
  return useMutation(checkoutMutation());
}

/** `mutate()` leaves for the Stripe customer portal: card, interval, invoices, cancel. */
export function useOpenBillingPortal() {
  return useMutation(portalMutation());
}
