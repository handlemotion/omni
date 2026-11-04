// The workspace's plan and AI triage allowance, and the Stripe hand-offs (ADR 0015).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  billingQuery,
  checkoutMutation,
  portalMutation,
  startTrialMutation,
} from "../lib/billing.ts";

/** `{ enabled: false }` without billing; else plan, prices, trial, `readOnly` and triage usage. */
export function useBilling(options: { enabled?: boolean } = {}) {
  return useQuery({ ...billingQuery(), enabled: options.enabled ?? true });
}

/** `mutate(interval)` starts the free trial now (no card); setup's plan step is then done. */
export function useStartTrial() {
  return useMutation(startTrialMutation(useQueryClient()));
}

/** `mutate({ interval, returnPath })` leaves for Stripe Checkout to pay. */
export function useStartCheckout() {
  return useMutation(checkoutMutation());
}

/** `mutate(returnPath)` leaves for the Stripe customer portal: card, interval, invoices, cancel. */
export function useOpenBillingPortal() {
  return useMutation(portalMutation());
}
