// Entry for the Better Auth CLI only: `pnpm --filter @omni/auth auth:generate` writes
// packages/db/src/schema/auth.ts from createAuth's options. Never edit that file by hand.
// postgres-js connects lazily, so this placeholder URL is never dialed.
import { createDb } from "@omni/db";
import { createAuth, type Auth } from "./src/index.ts";

export const auth: Auth = createAuth({
  db: createDb("postgres://schema-generation-only@127.0.0.1:1/none").db,
  secret: "schema-generation-only-schema-generation-only",
  baseURL: "http://localhost",
  // Billing on, so the Stripe plugin's tables and columns are part of the schema (they are
  // additive and unused when a deploy leaves billing off).
  billing: {
    secretKey: "sk_test_schema_generation_only",
    webhookSecret: "whsec_schema_generation_only",
    monthlyPriceId: "price_schema_generation_only",
    yearlyPriceId: undefined,
    publishableKey: undefined,
    trialDays: 0,
    triageAllowance: 1,
  },
  sendMagicLink: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
  sendInvitation: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
});
