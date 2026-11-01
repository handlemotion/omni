import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const dbEnv = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

/**
 * Reads `DATABASE_URL` for Node entry points (drizzle-kit, tests, scripts). A `.env` file in
 * `dir` fills in anything the process env (e.g. Doppler) did not already set.
 */
export function readDatabaseUrl(dir: string) {
  const file = join(dir, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
  const parsed = dbEnv.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      "DATABASE_URL is missing or not a postgres:// URL. Set it in the environment or in a .env file (see packages/db/.env.example).",
    );
  }
  return parsed.data.DATABASE_URL;
}
