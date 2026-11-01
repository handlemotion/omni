import { authEnvSchema } from "@omni/auth";
import { z } from "zod";

// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them. Documented in
// `.dev.vars.example`.
declare global {
  namespace Cloudflare {
    interface Env {
      BETTER_AUTH_SECRET: string;
      MAIL_SERVICE_HMAC_SECRET: string;
      ANTHROPIC_API_KEY?: string;
      TYPESAFE_API_KEY?: string;
      EXPO_ACCESS_TOKEN?: string;
    }
  }
}

const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const configSchema = z
  .object({
    MAIL_SERVICE_URL: z.url(),
    MAIL_SERVICE_HMAC_SECRET: z.string().min(32),
    /** Address of the mailbox that sends magic links. Required to sign in by email. */
    SYSTEM_MAIL_FROM: optionalText.pipe(z.email().optional()),
    SENTRY_DSN: optionalText.pipe(z.url().optional()),
    /** Empty runs only the rule path: ours-last threads file as waiting_on_them, no summaries. */
    ANTHROPIC_API_KEY: optionalText,
    /** Triage on TypeSafe's Jev when set (summaries stay on Claude). */
    TYPESAFE_API_KEY: optionalText,
    /** `jev` or `claude`; defaults to Jev when TYPESAFE_API_KEY is set. */
    TRIAGE_PROVIDER: optionalText.pipe(z.enum(["jev", "claude"]).optional()),
    JEV_MODEL: optionalText,
    /** Per org per UTC day, input + output. Over it, summaries pause; triage keeps running. */
    AI_DAILY_TOKEN_CAP: z.coerce.number().int().positive().default(1_000_000),
    /** Send Expo push notifications to members with no app open. Off by default. */
    EXPO_PUSH_ENABLED: z
      .enum(["true", "false", ""])
      .optional()
      .transform((v) => v === "true"),
    /** Optional: required only if the Expo project enforces push security. */
    EXPO_ACCESS_TOKEN: optionalText,
  })
  .and(z.object({ auth: authEnvSchema }));

export type Config = z.output<typeof configSchema>;

const cache = new WeakMap<object, Config>();

/** Validates the Worker's vars and secrets once per isolate; throws naming every bad variable. */
export function loadConfig(env: Env): Config {
  let config = cache.get(env);
  if (!config) {
    const parsed = configSchema.safeParse({ ...env, auth: env });
    if (!parsed.success) {
      // Names only: values may be secrets.
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`invalid Worker config:\n  ${problems.join("\n  ")}`);
    }
    config = parsed.data;
    cache.set(env, config);
  }
  return config;
}
