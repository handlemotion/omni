import { type Keyring, parseKeyring } from "@omni/crypto";
import { z } from "zod";

const keyring = z.string().transform((value, ctx) => {
  try {
    return parseKeyring(value) satisfies Keyring;
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER satisfies Keyring;
  }
});

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8788),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SENTRY_DSN: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.url().optional()),
  SENTRY_ENVIRONMENT: z.string().min(1).default("production"),
  MAIL_SERVICE_HMAC_SECRET: z.string().min(32),
  WORKER_URL: z.url(),
  MAIL_CREDENTIALS_KEY: keyring,
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_REGION: z.string().min(1).default("auto"),
  IMAGE_PROXY_URL: z.string().min(1).default("/api/image-proxy"),
  ATTACHMENT_URL: z.string().min(1).default("/api/attachments"),
  SYNC_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  NOTIFY_SWEEP_MS: z.coerce.number().int().positive().default(60_000),
  MAILBOX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  PURELYMAIL_API_TOKEN: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  PURELYMAIL_CREDIT_WARN_USD: z.coerce.number().nonnegative().default(5),
  GOOGLE_CLIENT_ID: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  GOOGLE_CLIENT_SECRET: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  GMAIL_SYNC_DAYS: z.coerce.number().int().nonnegative().default(7),
  DNS_RESOLVERS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  DNS_NAMESERVER_PORT: z.coerce.number().int().positive().max(65_535).default(53),
  DNS_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema
    .refine((config) => !config.GOOGLE_CLIENT_ID === !config.GOOGLE_CLIENT_SECRET, {
      message: "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither",
      path: ["GOOGLE_CLIENT_SECRET"],
    })
    .safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid mail service config:\n  ${problems.join("\n  ")}`);
  }
  return parsed.data satisfies Config;
}
