import { z } from "zod";
import { billingConfig, billingFields, checkBillingEnv, optionalText } from "./billing-env.ts";

const commaList = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

/** Auth variables, documented in `packages/auth/.env.example`. */
export const authEnvSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    AUTH_TRUSTED_ORIGINS: commaList,
    AUTH_PASSKEY_RP_ID: optionalText,
    APP_NAME: optionalText,
    WEB_APP_URL: optionalText.pipe(z.url().optional()),
    /** Google OAuth client. Both set turns on "Sign in with Google"; neither leaves it off. */
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    /** Apple OAuth client. Both set turns on "Sign in with Apple"; neither leaves it off. */
    APPLE_CLIENT_ID: optionalText,
    APPLE_CLIENT_SECRET: optionalText,
    APPLE_APP_BUNDLE_IDENTIFIER: optionalText,
    /**
     * Who may have an account. `open` (default): anyone with a verified email signs up
     * and creates their own workspace in onboarding. `invitation`: sign-up needs a pending
     * invitation, and only people who already own a workspace create another (the first comes
     * from the `org:create` CLI).
     */
    SIGN_UP: optionalText.pipe(z.enum(["open", "invitation"]).default("open")),
    /**
     * Hosts whose OAuth client metadata documents agents may sign in with. Empty:
     * Claude's and ChatGPT's (`claude.ai`, `chatgpt.com`).
     */
    MCP_CIMD_HOSTS: commaList,
    ...billingFields,
  })
  .refine((env) => !env.GOOGLE_CLIENT_ID === !env.GOOGLE_CLIENT_SECRET, {
    path: ["GOOGLE_CLIENT_SECRET"],
    message: "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither",
  })
  .refine((env) => !env.APPLE_CLIENT_ID === !env.APPLE_CLIENT_SECRET, {
    path: ["APPLE_CLIENT_SECRET"],
    message: "set APPLE_CLIENT_ID and APPLE_CLIENT_SECRET together, or neither",
  })
  .superRefine(checkBillingEnv)
  .transform((env) => ({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    passkeyRpId: env.AUTH_PASSKEY_RP_ID,
    appName: env.APP_NAME ?? "Omni",
    webAppURL: env.WEB_APP_URL ?? env.BETTER_AUTH_URL,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    apple:
      env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
        ? {
            clientId: env.APPLE_CLIENT_ID,
            clientSecret: env.APPLE_CLIENT_SECRET,
            ...(env.APPLE_APP_BUNDLE_IDENTIFIER
              ? { appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER }
              : {}),
          }
        : undefined,
    signUp: env.SIGN_UP,
    cimdHosts: env.MCP_CIMD_HOSTS,
    billing: billingConfig(env),
  }));

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Validates auth config from the environment at startup; throws listing every bad variable. */
export function parseAuthEnv(env: Record<string, unknown>) {
  return authEnvSchema.parse(env) satisfies AuthConfig;
}

export type SignUp = AuthConfig["signUp"];

/** Present only when billing is on (`STRIPE_SECRET_KEY` and friends set). */
export type BillingConfig = NonNullable<AuthConfig["billing"]>;
