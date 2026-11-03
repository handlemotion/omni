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
      GOOGLE_CLIENT_SECRET?: string;
      DOMAIN_CONNECT_PRIVATE_KEY?: string;
    }
  }
}

const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/** `<count>/<seconds>`, e.g. `5/900` for five per 15 minutes; `off` disables the rule. */
function rateLimit(fallback: string) {
  return z
    .string()
    .optional()
    .transform((value) => value || fallback)
    .pipe(
      z
        .string()
        .regex(/^(off|[1-9]\d*\/[1-9]\d*)$/, 'use "<count>/<seconds>" (e.g. "5/900") or "off"'),
    )
    .transform((value) => {
      if (value === "off") return null;
      const [count, windowSeconds] = value.split("/").map(Number) as [number, number];
      return { count, windowSeconds };
    });
}

export type RateLimit = { count: number; windowSeconds: number } | null;

const configSchema = z
  .object({
    MAIL_SERVICE_URL: z.url(),
    MAIL_SERVICE_HMAC_SECRET: z.string().min(32),
    /** Address of the mailbox that sends magic links. Required to sign in by email. */
    SYSTEM_MAIL_FROM: optionalText.pipe(z.email().optional()),
    SENTRY_DSN: optionalText.pipe(z.url().optional()),
    /** Empty with no TYPESAFE_API_KEY: no triage beyond the wordless-reply rule, no summaries. */
    ANTHROPIC_API_KEY: optionalText,
    /** Triage on TypeSafe's Jev when set (summaries stay on Claude). */
    TYPESAFE_API_KEY: optionalText,
    /** `jev` or `claude`; defaults to Jev when TYPESAFE_API_KEY is set. */
    TRIAGE_PROVIDER: optionalText.pipe(z.enum(["jev", "claude"]).optional()),
    JEV_MODEL: optionalText,
    /** TypeSafe API base URL; defaults to https://api.typesafe.ai. */
    TYPESAFE_API_URL: optionalText.pipe(z.url().optional()),
    /** Per org per UTC day, input + output. Over it, summaries pause; triage keeps running. */
    AI_DAILY_TOKEN_CAP: z.coerce.number().int().positive().default(1_000_000),
    /** Send Expo push notifications to members with no app open. Off by default. */
    EXPO_PUSH_ENABLED: z
      .enum(["true", "false", ""])
      .optional()
      .transform((v) => v === "true"),
    /** DNS-over-HTTPS (JSON) resolver the image proxy uses to refuse private addresses. */
    IMAGE_PROXY_DOH_URL: z.url().default("https://cloudflare-dns.com/dns-query"),
    /**
     * `production` by default. `test` (e2e suites) unlocks test-only switches; `development`
     * also logs magic-link and invitation URLs to the console for local sign-in.
     */
    ENVIRONMENT: z.enum(["production", "development", "test"]).default("production"),
    /** Test-only: one origin exempt from the proxy's address checks. Refused unless ENVIRONMENT=test. */
    IMAGE_PROXY_TEST_ALLOW_ORIGIN: optionalText.pipe(z.url().optional()),
    /**
     * Domain Connect (ADR 0011): the provider id our templates are published under. Empty keeps
     * "Set up automatically" off; members add records by hand.
     */
    DOMAIN_CONNECT_PROVIDER_ID: optionalText,
    /** Host of the TXT record holding our public key, for templates that require signed requests. */
    DOMAIN_CONNECT_KEY_HOST: optionalText,
    /** PKCS#8 PEM private key that signs apply URLs. Needs DOMAIN_CONNECT_KEY_HOST. */
    DOMAIN_CONNECT_PRIVATE_KEY: optionalText,
    /** Optional: required only if the Expo project enforces push security. */
    EXPO_ACCESS_TOKEN: optionalText,
    // Rate limits (see rate-limiter.ts). Defaults leave room for real use; tighten per deploy.
    /** Per IP: every sign-in step (magic link, passkey, Google, verify links). */
    RATE_LIMIT_AUTH: rateLimit("60/60"),
    /** Per email address: magic-link requests, each of which sends mail. */
    RATE_LIMIT_MAGIC_LINK: rateLimit("5/900"),
    /** Per inviting user: invitations sent or resent. */
    RATE_LIMIT_INVITE: rateLimit("30/3600"),
    /** Per member: full-text searches. */
    RATE_LIMIT_SEARCH: rateLimit("60/60"),
    /** Per member: new mail and replies. */
    RATE_LIMIT_SEND: rateLimit("100/3600"),
    /** Per member: other outbox writes (read state, done, defer, archive, move). */
    RATE_LIMIT_ACTIONS: rateLimit("300/60"),
    /** Per member: creating mailboxes (a mail service call). Domains have their own limiters. */
    RATE_LIMIT_PROVISION: rateLimit("30/3600"),
    /** Per member: image proxy fetches of images not already cached. */
    RATE_LIMIT_IMAGE_PROXY: rateLimit("300/60"),
  })
  .refine((env) => !env.IMAGE_PROXY_TEST_ALLOW_ORIGIN || env.ENVIRONMENT === "test", {
    path: ["IMAGE_PROXY_TEST_ALLOW_ORIGIN"],
    message: "is test-only; it is refused unless ENVIRONMENT=test",
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
