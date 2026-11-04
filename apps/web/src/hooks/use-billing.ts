// The workspace's plan and AI triage allowance, and the Stripe hand-offs (ADR 0015).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  billingCardsQuery,
  billingInvoicesQuery,
  billingQuery,
  cardAddedMutation,
  cardSetupMutation,
  checkoutMutation,
  defaultCardMutation,
  removeCardMutation,
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

/** The saved cards (owners and admins; pass `enabled: false` for anyone else). */
export function useBillingCards(options: { enabled?: boolean } = {}) {
  return useQuery({ ...billingCardsQuery(), enabled: options.enabled ?? true });
}

/** The workspace's invoices (owners and admins; pass `enabled: false` for anyone else). */
export function useBillingInvoices(options: { enabled?: boolean } = {}) {
  return useQuery({ ...billingInvoicesQuery(), enabled: options.enabled ?? true });
}

/** `mutateAsync()` gets a SetupIntent's secret and the publishable key for Stripe.js. */
export function useCardSetup() {
  return useMutation(cardSetupMutation());
}

/** `mutate(setupIntentId)` once Stripe confirmed the card: it joins the list. */
export function useCardAdded() {
  return useMutation(cardAddedMutation(useQueryClient()));
}

/** `mutate(cardId)` makes the plan charge that card. */
export function useMakeDefaultCard() {
  return useMutation(defaultCardMutation(useQueryClient()));
}

/** `mutate(cardId)` removes the card from Stripe. */
export function useRemoveCard() {
  return useMutation(removeCardMutation(useQueryClient()));
}
