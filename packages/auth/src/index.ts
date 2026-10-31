import { passkey } from "@better-auth/passkey";
import type { Db } from "@omni/db";
import { schema } from "@omni/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

export type MagicLinkSender = (message: { email: string; url: string }) => Promise<void>;

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

// Blank lines in a .env file arrive as "", which means unset.
const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/** Auth variables, documented in `packages/auth/.env.example`. */
export const authEnvSchema = z
  .object({
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    AUTH_TRUSTED_ORIGINS: commaList,
    AUTH_PASSKEY_RP_ID: optionalText,
    APP_NAME: optionalText,
  })
  .transform((env) => ({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    passkeyRpId: env.AUTH_PASSKEY_RP_ID,
    appName: env.APP_NAME ?? "Omni",
  }));

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Validates auth config from the environment at startup; throws listing every bad variable. */
export function parseAuthEnv(env: Record<string, unknown>): AuthConfig {
  return authEnvSchema.parse(env);
}

export interface AuthEnv extends Partial<
  Pick<AuthConfig, "trustedOrigins" | "passkeyRpId" | "appName">
> {
  db: Db;
  /** BETTER_AUTH_SECRET */
  secret: string;
  /** BETTER_AUTH_URL, the API's public origin. */
  baseURL: string;
  /** Delivers the magic link. The Worker injects the real sender. */
  sendMagicLink: MagicLinkSender;
}

/**
 * Better Auth instance for one request scope. The Worker calls this with its bindings, and
 * `auth.config.ts` calls it so the CLI generates `@omni/db`'s auth schema from the same options.
 * Model names are plural to match our tables.
 */
export function createAuth(env: AuthEnv) {
  return betterAuth({
    appName: env.appName ?? "Omni",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: env.trustedOrigins ?? [],
    database: drizzleAdapter(env.db, { provider: "pg", schema }),
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    advanced: { database: { generateId: () => uuidv7() } },
    plugins: [
      magicLink({ sendMagicLink: ({ email, url }) => env.sendMagicLink({ email, url }) }),
      passkey({
        rpName: env.appName ?? "Omni",
        ...(env.passkeyRpId ? { rpID: env.passkeyRpId } : {}),
        schema: { passkey: { modelName: "passkeys" } },
      }),
      organization({
        allowUserToCreateOrganization: false,
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "members" },
          invitation: { modelName: "invitations" },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
