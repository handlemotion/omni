import { z } from "zod";

const base64Key = z
  .string()
  .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes, base64");

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Shared with the Worker; verifies its pings once `@omni/crypto` is wired in. */
  MAIL_SERVICE_HMAC_SECRET: z.string().min(32),
  /** AES-256-GCM key for `mailboxes.credentials_enc`. Only this service holds it. */
  MAIL_CREDENTIALS_KEY: base64Key,
  SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  MAILBOX_CONCURRENCY: z.coerce.number().int().positive().default(4),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names only: values may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid mail service config:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data;
}
