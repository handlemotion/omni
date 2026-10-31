import { passkey } from "@better-auth/passkey";
import type { Db } from "@omni/db";
import { schema } from "@omni/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins/magic-link";
import { organization } from "better-auth/plugins/organization";
import { uuidv7 } from "uuidv7";

export type MagicLinkSender = (message: { email: string; url: string }) => Promise<void>;

export interface AuthEnv {
  db: Db;
  /** BETTER_AUTH_SECRET */
  secret: string;
  /** BETTER_AUTH_URL, the API's public origin. */
  baseURL: string;
  /** Web and app origins allowed to call the auth endpoints. */
  trustedOrigins?: string[];
  /** WebAuthn relying party, e.g. `omnidirectional.app`. Defaults to the baseURL host. */
  passkeyRpId?: string;
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
    appName: "Omnidirectional",
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
        rpName: "Omnidirectional",
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
