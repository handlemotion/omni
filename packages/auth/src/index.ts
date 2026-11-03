import { passkey } from "@better-auth/passkey";
import type { Db } from "@omni/db";
import { schema } from "@omni/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";

export type MagicLinkSender = (message: { email: string; url: string }) => Promise<void>;

export interface InvitationMessage {
  invitationId: string;
  email: string;
  /** `<WEB_APP_URL>/invite/<invitationId>`: the web app's accept page. */
  url: string;
  organizationName: string;
  inviterName: string;
  expiresAt: Date;
}

export type InvitationSender = (message: InvitationMessage) => Promise<void>;

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
    WEB_APP_URL: optionalText.pipe(z.url().optional()),
    /** Google OAuth client. Both set turns on "Sign in with Google"; neither leaves it off. */
    GOOGLE_CLIENT_ID: optionalText,
    GOOGLE_CLIENT_SECRET: optionalText,
    /**
     * Who may create an organization in the app: `owners` (people who already own one; the first
     * comes from the `org:create` CLI) or `anyone` signed in. Sign-up stays invitation-only.
     */
    ORGANIZATION_CREATION: optionalText.pipe(z.enum(["owners", "anyone"]).default("owners")),
  })
  .refine((env) => !env.GOOGLE_CLIENT_ID === !env.GOOGLE_CLIENT_SECRET, {
    path: ["GOOGLE_CLIENT_SECRET"],
    message: "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither",
  })
  .transform((env) => ({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: env.AUTH_TRUSTED_ORIGINS,
    passkeyRpId: env.AUTH_PASSKEY_RP_ID,
    appName: env.APP_NAME ?? "Omni",
    /** Origin of the web app; invitation links point here. Same origin as the API by default. */
    webAppURL: env.WEB_APP_URL ?? env.BETTER_AUTH_URL,
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : undefined,
    organizationCreation: env.ORGANIZATION_CREATION,
  }));

export type AuthConfig = z.output<typeof authEnvSchema>;

/** Validates auth config from the environment at startup; throws listing every bad variable. */
export function parseAuthEnv(env: Record<string, unknown>): AuthConfig {
  return authEnvSchema.parse(env);
}

export type OrganizationCreation = AuthConfig["organizationCreation"];

export interface AuthEnv extends Partial<
  Pick<
    AuthConfig,
    "trustedOrigins" | "passkeyRpId" | "appName" | "webAppURL" | "google" | "organizationCreation"
  >
> {
  db: Db;
  /** BETTER_AUTH_SECRET */
  secret: string;
  /** BETTER_AUTH_URL, the API's public origin. */
  baseURL: string;
  /** Delivers the magic link. The Worker injects the real sender. */
  sendMagicLink: MagicLinkSender;
  /** Delivers an organization invitation. The Worker injects the real sender. */
  sendInvitation: InvitationSender;
}

/**
 * Sign-up is by invitation only. A known user may always sign in; an unknown email may sign up
 * only while it holds a pending, unexpired invitation to some organization.
 */
export async function maySignIn(db: Db, email: string) {
  const address = email.toLowerCase();
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, address))
    .limit(1);
  return user !== undefined || (await hasPendingInvitation(db, address));
}

/**
 * Whether `userId` may create an organization in the app under `policy`. `owners`: only someone
 * who already owns one (they set up a second workspace); everyone else joins by invitation.
 */
export async function mayCreateOrganization(
  db: Db,
  userId: string,
  policy: OrganizationCreation = "owners",
) {
  if (policy === "anyone") return true;
  const [owned] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(and(eq(schema.members.userId, userId), eq(schema.members.role, "owner")))
    .limit(1);
  return owned !== undefined;
}

async function hasPendingInvitation(db: Db, email: string) {
  const [invitation] = await db
    .select({ id: schema.invitations.id })
    .from(schema.invitations)
    .where(
      and(
        eq(sql`lower(${schema.invitations.email})`, email.toLowerCase()),
        eq(schema.invitations.status, "pending"),
        gt(schema.invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invitation !== undefined;
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
    // Sign-up stays invitation-only: a new Google user goes through the same `user.create` hook.
    // `select_account` lets one browser add a second Google account (multi-session).
    socialProviders: env.google
      ? { google: { ...env.google, prompt: "select_account" } }
      : undefined,
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    advanced: { database: { generateId: () => uuidv7() } },
    databaseHooks: {
      user: {
        create: {
          // The one place every sign-up path (magic-link verify, Google callback) creates a user. A link
          // issued while the invitation was pending stops working once it is canceled.
          before: async (user) => {
            if (!(await hasPendingInvitation(env.db, user.email))) {
              throw new APIError("FORBIDDEN", {
                code: "SIGN_UP_REQUIRES_INVITATION",
                message: "sign-up needs a pending invitation",
              });
            }
          },
        },
      },
      session: {
        create: {
          // A new session starts in the user's oldest org, the same default `requireMember`
          // uses, so Better Auth's organization endpoints and our API agree from the first call.
          before: async (session) => {
            const [member] = await env.db
              .select({ orgId: schema.members.organizationId })
              .from(schema.members)
              .where(eq(schema.members.userId, session.userId))
              .orderBy(asc(schema.members.createdAt))
              .limit(1);
            return { data: { ...session, activeOrganizationId: member?.orgId ?? null } };
          },
        },
      },
    },
    plugins: [
      magicLink({
        // An email that may not sign in gets the same 200 and no mail, so the endpoint does not
        // reveal who has an account, and our system mailbox never mails a stranger.
        sendMagicLink: async ({ email, url }) => {
          if (await maySignIn(env.db, email)) await env.sendMagicLink({ email, url });
        },
      }),
      passkey({
        rpName: env.appName ?? "Omni",
        ...(env.passkeyRpId ? { rpID: env.passkeyRpId } : {}),
        schema: { passkey: { modelName: "passkeys" } },
      }),
      organization({
        // The first organization comes from the `org:create` CLI; after that, per
        // ORGANIZATION_CREATION (onboarding creates one, ADR 0007). Members join by invitation.
        // The creator becomes its owner and it becomes their active organization.
        allowUserToCreateOrganization: (user) =>
          mayCreateOrganization(env.db, user.id, env.organizationCreation),
        sendInvitationEmail: ({ id, email, organization, inviter, invitation }) =>
          env.sendInvitation({
            invitationId: id,
            email,
            url: new URL(
              `/invite/${encodeURIComponent(id)}`,
              env.webAppURL ?? env.baseURL,
            ).toString(),
            organizationName: organization.name,
            inviterName: inviter.user.name || inviter.user.email,
            expiresAt: invitation.expiresAt,
          }),
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "members" },
          invitation: { modelName: "invitations" },
        },
      }),
      // Several accounts signed in on one device; switch with `multiSession.setActive`.
      multiSession(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
