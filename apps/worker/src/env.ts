import { authEnvSchema } from "@omni/auth";
import { z } from "zod";

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
      STRIPE_SECRET_KEY?: string;
      STRIPE_WEBHOOK_SECRET?: string;
    }
  }
}

const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const optionalGb = z.coerce.number<string | undefined>().positive().optional();

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
    SYSTEM_MAIL_FROM: optionalText.pipe(z.email().optional()),
    SENTRY_DSN: optionalText.pipe(z.url().optional()),
    ANTHROPIC_API_KEY: optionalText,
    TYPESAFE_API_KEY: optionalText,
    TRIAGE_PROVIDER: optionalText.pipe(z.enum(["jev", "claude"]).optional()),
    JEV_MODEL: optionalText,
    TYPESAFE_API_URL: optionalText.pipe(z.url().optional()),
    EXPO_PUSH_ENABLED: z
      .enum(["true", "false", ""])
      .optional()
      .transform((v) => v === "true"),
    IMAGE_PROXY_DOH_URL: z.url().default("https://cloudflare-dns.com/dns-query"),
    SENDER_LOGO_ICON_SERVICE: optionalText.pipe(
      z.string().default("https://www.google.com/s2/favicons?domain={domain}&sz=128"),
    ),
    SENDER_LOGO_GRAVATAR: optionalText.pipe(
      z.string().default("https://gravatar.com/avatar/{hash}?s=160&d=404"),
    ),
    ENVIRONMENT: z.enum(["production", "development", "test"]).default("production"),
    IMAGE_PROXY_TEST_ALLOW_ORIGIN: optionalText.pipe(z.url().optional()),
    DOMAIN_CONNECT_PROVIDER_ID: optionalText,
    DOMAIN_CONNECT_KEY_HOST: optionalText,
    DOMAIN_CONNECT_PRIVATE_KEY: optionalText,
    UPLOAD_MAX_BYTES: optionalText.pipe(
      z.coerce
        .number<string | undefined>()
        .int()
        .positive()
        .default(25 * 1024 * 1024),
    ),
    STORAGE_MAX_FILE_BYTES: optionalText.pipe(
      z.coerce
        .number<string | undefined>()
        .int()
        .positive()
        .default(100 * 1024 ** 3),
    ),
    STORAGE_HASH_CHECK_MAX_BYTES: optionalText.pipe(
      z.coerce
        .number<string | undefined>()
        .int()
        .nonnegative()
        .default(8 * 1024 ** 3),
    ),
    STORAGE_MAX_OPEN_UPLOADS: optionalText.pipe(
      z.coerce.number<string | undefined>().int().positive().default(500),
    ),
    STORAGE_MAX_RESERVED_BYTES: optionalText.pipe(
      z.coerce
        .number<string | undefined>()
        .int()
        .positive()
        .default(1024 ** 4),
    ),
    STORAGE_PERSONAL_GB: optionalText.pipe(optionalGb),
    STORAGE_MAX_GB: optionalText.pipe(optionalGb),
    S2_BASIN_URL: optionalText.pipe(z.url().optional()),
    S2_BASIN: optionalText,
    S2_ACCESS_TOKEN: optionalText,
    EXPO_ACCESS_TOKEN: optionalText,
    RATE_LIMIT_AUTH: rateLimit("60/60"),
    RATE_LIMIT_MAGIC_LINK: rateLimit("5/900"),
    RATE_LIMIT_INVITE: rateLimit("30/3600"),
    RATE_LIMIT_SEARCH: rateLimit("60/60"),
    RATE_LIMIT_SEND: rateLimit("100/3600"),
    RATE_LIMIT_ACTIONS: rateLimit("300/60"),
    RATE_LIMIT_PROVISION: rateLimit("30/3600"),
    RATE_LIMIT_IMAGE_PROXY: rateLimit("300/60"),
    RATE_LIMIT_STORAGE_SHARE: rateLimit("60/3600"),
    RATE_LIMIT_STORAGE_SHARE_NEW: rateLimit("10/86400"),
    RATE_LIMIT_STORAGE_LINK: rateLimit("300/60"),
    RATE_LIMIT_STORAGE_LINK_PASSWORD: rateLimit("10/900"),
    RATE_LIMIT_STORAGE_SYNC: rateLimit("600/60"),
  })
  .refine((env) => !env.S2_BASIN_URL || !!env.S2_BASIN, {
    path: ["S2_BASIN"],
    message: "is required with S2_BASIN_URL",
  })
  .refine((env) => !env.IMAGE_PROXY_TEST_ALLOW_ORIGIN || env.ENVIRONMENT === "test", {
    path: ["IMAGE_PROXY_TEST_ALLOW_ORIGIN"],
    message: "is test-only; it is refused unless ENVIRONMENT=test",
  })
  .and(z.object({ auth: authEnvSchema }));

export type Config = z.output<typeof configSchema>;

const cache = new WeakMap<object, Config>();

/** Validates the Worker's vars and secrets once per isolate; throws naming every bad variable. */
export function loadConfig(env: Env) {
  let config = cache.get(env);
  if (!config) {
    const parsed = configSchema.safeParse({ ...env, auth: env });
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`invalid Worker config:\n  ${problems.join("\n  ")}`);
    }
    config = parsed.data;
    cache.set(env, config);
  }
  return config satisfies Config;
}
