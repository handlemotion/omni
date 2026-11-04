// The workspace's plan (`GET /api/billing`, ADR 0015) and the two ways out to Stripe: Checkout to
// start the trial or subscribe, the customer portal to manage it. Both answer with a Stripe URL;
// the browser leaves the app for it and Stripe sends it back to `returnPath`.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

/**
 * `{ enabled: false }` on an install without billing. Otherwise the plan, whether the workspace
 * is read-only, its prices and trial, and this period's AI triage against the allowance.
 */
export const billingQuery = () =>
  queryOptions({
    queryKey: keys.billing(),
    queryFn: ({ signal }) => call(api.billing.$get(undefined, { init: { signal } })),
  });

export type Interval = "month" | "year";

/**
 * `mutate(interval)` starts the workspace's free trial now, with no card and no Stripe page, then
 * reloads what depends on it (setup's plan step, the plan itself).
 */
export const startTrialMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (interval: Interval) => call(api.billing.trial.$post({ json: { interval } })),
    onSuccess: () =>
      Promise.all([
        client.refetchQueries({ queryKey: keys.onboarding() }),
        client.refetchQueries({ queryKey: keys.billing() }),
      ]),
  });

export interface CheckoutChoice {
  interval: Interval;
  /** An app path Stripe returns to, paid or not (e.g. `/onboarding`). */
  returnPath: string;
}

/**
 * `mutate(choice)` leaves for Stripe Checkout, to pay for a workspace that has had its trial.
 * Promotion codes are entered on Stripe's page.
 */
export const checkoutMutation = () =>
  mutationOptions({
    mutationFn: async (choice: CheckoutChoice) => {
      const { url } = await call(api.billing.checkout.$post({ json: choice }));
      window.location.assign(url);
    },
  });

/** `mutate(returnPath)` leaves for the Stripe customer portal: card, interval, invoices, cancel. */
export const portalMutation = () =>
  mutationOptions({
    mutationFn: async (returnPath: string) => {
      const { url } = await call(api.billing.portal.$post({ json: { returnPath } }));
      window.location.assign(url);
    },
  });

/** "$19", from Stripe's smallest-unit amount, in the visitor's locale. */
export function formatPrice(price: { amount: number; currency: string }) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: price.amount % 100 === 0 ? 0 : 2,
  }).format(price.amount / 100);
}

/** The saved cards, the one charged first, and whether a card can be added in the app. */
export const billingCardsQuery = () =>
  queryOptions({
    queryKey: keys.billingCards(),
    queryFn: ({ signal }) => call(api.billing.cards.$get(undefined, { init: { signal } })),
  });

/** Invoices, newest first, each with Stripe's page and PDF when Stripe has them. */
export const billingInvoicesQuery = () =>
  queryOptions({
    queryKey: keys.billingInvoices(),
    queryFn: ({ signal }) => call(api.billing.invoices.$get(undefined, { init: { signal } })),
  });

export type Cards = Awaited<
  ReturnType<NonNullable<ReturnType<typeof billingCardsQuery>["queryFn"]>>
>;
export type Card = Cards["cards"][number];
export type Invoice = Awaited<
  ReturnType<NonNullable<ReturnType<typeof billingInvoicesQuery>["queryFn"]>>
>["invoices"][number];

/** Each card change answers with the cards as they are now; the cache takes them as they come. */
const cardsChanged = (client: QueryClient) => (cards: Cards) =>
  client.setQueryData(keys.billingCards(), cards);

/** `mutateAsync()` asks for a SetupIntent: the secret and key Stripe.js needs to take a card. */
export const cardSetupMutation = () =>
  mutationOptions({
    mutationFn: () => call(api.billing.cards.setup.$post()),
  });

/** `mutate(setupIntentId)` after Stripe confirmed it: the card is listed (and charged if first). */
export const cardAddedMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (setupIntent: string) => call(api.billing.cards.$post({ json: { setupIntent } })),
    onSuccess: cardsChanged(client),
  });

/** `mutate(cardId)` makes the plan charge this card from now on. */
export const defaultCardMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.billing.cards[":id"].default.$post({ param: { id } })),
    onSuccess: cardsChanged(client),
  });

/** `mutate(cardId)` removes the card from Stripe; the last one stays while the plan needs it. */
export const removeCardMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.billing.cards[":id"].$delete({ param: { id } })),
    onSuccess: cardsChanged(client),
  });
