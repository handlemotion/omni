import { defineConfig } from "drizzle-kit";
import { readDatabaseUrl } from "./src/env.ts";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.argv.includes("generate") ? "" : readDatabaseUrl(process.cwd()),
  },
  strict: true,
  verbose: true,
});
