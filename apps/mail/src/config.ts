import { type Keyring, parseKeyring } from "@omni/crypto";
import { z } from "zod";

const keyring = z.string().transform((value, ctx): Keyring => {
  try {
    return parseKeyring(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});

const schema = z.object({
  /** 8788 locally: the Worker's `wrangler dev` owns 8787. */
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Shared with the Worker; verifies its pings once `@omni/crypto` is wired in. */
  MAIL_SERVICE_HMAC_SECRET: z.string().min(32),
  /**
   * Keyring for `mailboxes.credentials_enc`: `k1:<base64 32 bytes>`, comma-separated, current key
   * first. Only this service holds it.
   */
  MAIL_CREDENTIALS_KEY: keyring,
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
