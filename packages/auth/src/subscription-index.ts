// A schema-only plugin: one row per Stripe subscription (ADR 0015). The Stripe plugin's own
// schema has no unique key on `stripeSubscriptionId`, and both its webhook handlers and the daily
// reconcile create rows find-then-insert, so two writers racing could store one subscription
// twice. Better Auth merges every plugin's schema per model, so this marks the column unique in
// the plugin's table and `auth:generate` writes it into the Drizzle schema. Nulls stay allowed (a row
// checkout made before Stripe knew its id), and Postgres never counts two nulls as duplicates.
import type { BetterAuthPlugin } from "better-auth";

export const subscriptionIndex = () =>
  ({
    id: "omni-subscription-index",
    schema: {
      subscription: {
        modelName: "subscriptions",
        // The Stripe plugin's own definition of the field, plus `unique`. Better Auth refuses a
        // unique index on an optional field; a unique column is what `membershipKey` uses too.
        fields: { stripeSubscriptionId: { type: "string", required: false, unique: true } },
      },
    },
  }) satisfies BetterAuthPlugin;
