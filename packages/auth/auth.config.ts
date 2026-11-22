import { createDb } from "@omni/db";
import { createAuth, type Auth } from "./src/index.ts";

export const auth: Auth = createAuth({
  db: createDb("postgres://schema-generation-only@127.0.0.1:1/none").db,
  secret: "schema-generation-only-schema-generation-only",
  baseURL: "http://localhost",
  modules: [],
  billing: {
    secretKey: "sk_test_schema_generation_only",
    webhookSecret: "whsec_schema_generation_only",
    plans: { team: { monthlyPriceId: "price_schema_generation_only", yearlyPriceId: undefined } },
    publishableKey: undefined,
    storage: undefined,
  },
  sendMagicLink: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
  sendInvitation: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
});
