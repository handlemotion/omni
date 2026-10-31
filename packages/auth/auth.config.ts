// Entry for the Better Auth CLI only: `pnpm --filter @omni/auth auth:generate` writes
// packages/db/src/schema/auth.ts from createAuth's options. Never edit that file by hand.
// postgres-js connects lazily, so this placeholder URL is never dialed.
import { createDb } from "@omni/db";
import { createAuth } from "./src/index.ts";

export const auth = createAuth({
  db: createDb("postgres://schema-generation-only@127.0.0.1:1/none").db,
  secret: "schema-generation-only-schema-generation-only",
  baseURL: "http://localhost",
  sendMagicLink: async () => {
    throw new Error("auth.config.ts is for schema generation only");
  },
});
